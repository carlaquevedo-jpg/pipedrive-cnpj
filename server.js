require('dotenv').config();

const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

const CLIENT_ID = process.env.PIPEDRIVE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PIPEDRIVE_CLIENT_SECRET || '';
const JWT_SECRET = process.env.PIPEDRIVE_JWT_SECRET || CLIENT_SECRET;
const CALLBACK_URL = process.env.PIPEDRIVE_CALLBACK_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const CNPJ_FIELD_KEY_ENV = process.env.PIPEDRIVE_CNPJ_FIELD_KEY || '';

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

app.use(express.json({ limit: '200kb' }));
app.use('/assets', express.static(path.join(__dirname, 'public')));

function assertConfig() {
  const missing = [];
  if (!CLIENT_ID) missing.push('PIPEDRIVE_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('PIPEDRIVE_CLIENT_SECRET');
  if (!CALLBACK_URL) missing.push('PIPEDRIVE_CALLBACK_URL');
  if (!DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length) {
    throw new Error(`Configuração ausente: ${missing.join(', ')}`);
  }
}

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipedrive_oauth (
      company_id BIGINT PRIMARY KEY,
      user_id BIGINT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      api_domain TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cnpj_registry (
      company_id BIGINT NOT NULL,
      cnpj VARCHAR(14) NOT NULL,
      organization_id BIGINT,
      status VARCHAR(20) NOT NULL DEFAULT 'creating',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, cnpj)
    )
  `);
}

function normalizeCnpj(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 14);
}

function formatCnpj(value) {
  const v = normalizeCnpj(value);
  if (v.length !== 14) return v;
  return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12, 14)}`;
}

// Compatível com o CNPJ numérico legado e com o CNPJ alfanumérico (2026).
// Para as 12 primeiras posições: valor = ASCII - 48. Os 2 DVs continuam numéricos.
function isValidCnpj(value) {
  const cnpj = normalizeCnpj(value);
  if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj)) return false;

  // Evita sequências numéricas legadas obviamente inválidas (000..., 111..., etc.).
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const charValue = (ch) => ch.charCodeAt(0) - 48;

  const calc = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i += 1) {
      sum += charValue(base[i]) * weights[i];
    }
    const remainder = sum % 11;
    return remainder === 0 || remainder === 1 ? 0 : 11 - remainder;
  };

  const d1 = calc(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== Number(cnpj[12])) return false;

  const d2 = calc(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d2 === Number(cnpj[13]);
}

function verifyExtensionToken(token) {
  if (!JWT_SECRET) throw new Error('PIPEDRIVE_JWT_SECRET/CLIENT_SECRET não configurado.');
  if (!token) throw new Error('Token do Pipedrive não informado.');
  return jwt.verify(token, JWT_SECRET);
}

function companyIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.companyId ?? payload.company_id ?? payload.company?.id ?? null;
}

function validateCompanyAgainstToken(payload, companyId) {
  const tokenCompany = companyIdFromPayload(payload);
  if (tokenCompany != null && String(tokenCompany) !== String(companyId)) {
    const err = new Error('Empresa do token não corresponde ao contexto informado.');
    err.status = 403;
    throw err;
  }
}

async function exchangeAuthorizationCode(code) {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK_URL
  });

  const response = await fetch('https://oauth.pipedrive.com/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `OAuth HTTP ${response.status}`);
  }
  return data;
}

async function refreshOauth(row) {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token
  });

  const response = await fetch('https://oauth.pipedrive.com/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Falha ao renovar OAuth (${response.status})`);
  }

  const expiresAt = new Date(Date.now() + Number(data.expires_in || 3600) * 1000);
  const updated = await pool.query(
    `UPDATE pipedrive_oauth
       SET access_token = $2,
           refresh_token = $3,
           api_domain = $4,
           expires_at = $5,
           updated_at = NOW()
     WHERE company_id = $1
     RETURNING *`,
    [row.company_id, data.access_token, data.refresh_token, data.api_domain || row.api_domain, expiresAt]
  );

  return updated.rows[0];
}

async function getOauth(companyId) {
  if (!pool) throw new Error('DATABASE_URL não configurada.');
  const result = await pool.query('SELECT * FROM pipedrive_oauth WHERE company_id = $1', [companyId]);
  if (!result.rows.length) {
    const err = new Error('Aplicativo ainda não está autorizado para esta empresa do Pipedrive.');
    err.status = 401;
    throw err;
  }

  let row = result.rows[0];
  const expires = new Date(row.expires_at).getTime();
  if (expires <= Date.now() + 120000) {
    row = await refreshOauth(row);
  }
  return row;
}

async function pipedriveRequest(companyId, endpoint, options = {}) {
  let oauth = await getOauth(companyId);

  const doRequest = async (accessToken) => {
    const response = await fetch(`${oauth.api_domain}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
        Authorization: `Bearer ${accessToken}`
      }
    });
    const json = await response.json().catch(() => ({}));
    return { response, json };
  };

  let result = await doRequest(oauth.access_token);
  if (result.response.status === 401) {
    oauth = await refreshOauth(oauth);
    result = await doRequest(oauth.access_token);
  }

  if (!result.response.ok || result.json.success === false) {
    const message = result.json.error || result.json.error_info || `Pipedrive HTTP ${result.response.status}`;
    const err = new Error(message);
    err.status = result.response.status;
    throw err;
  }

  return result.json;
}

function normalizeFieldName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function getCnpjFieldKey(companyId) {
  if (CNPJ_FIELD_KEY_ENV) return CNPJ_FIELD_KEY_ENV;

  const fields = await pipedriveRequest(companyId, '/api/v2/organizationFields?limit=500');
  const list = Array.isArray(fields.data) ? fields.data : [];

  const exact = list.find((f) => normalizeFieldName(f.name || f.field_name) === 'cnpj');
  const candidate = exact || list.find((f) => normalizeFieldName(f.name || f.field_name).includes('cnpj'));

  if (!candidate) {
    const err = new Error('Não encontrei um campo de Organização chamado CNPJ no Pipedrive.');
    err.status = 422;
    throw err;
  }

  const key = candidate.key || candidate.code || candidate.field_code;
  if (!key) throw new Error('Campo CNPJ encontrado, mas a chave do campo não veio na resposta da API.');
  return key;
}

function searchResultId(item) {
  return item?.id ?? item?.item_id ?? item?.item?.id ?? item?.result?.id ?? null;
}

async function getOrganization(companyId, organizationId, cnpjFieldKey) {
  const json = await pipedriveRequest(
    companyId,
    `/api/v2/organizations/${encodeURIComponent(organizationId)}?custom_fields=${encodeURIComponent(cnpjFieldKey)}`
  );
  return json.data;
}

async function searchOrganizationByCnpj(companyId, rawCnpj) {
  const cnpj = normalizeCnpj(rawCnpj);
  const field = await getCnpjFieldKey(companyId);
  const formatted = formatCnpj(cnpj);

  const variants = [...new Set([
    cnpj,
    formatted,
    cnpj.toLowerCase(),
    formatted.toLowerCase()
  ])];

  for (const term of variants) {
    const params = new URLSearchParams({
      term,
      entity_type: 'organization',
      match: 'exact',
      field,
      limit: '10'
    });

    const json = await pipedriveRequest(companyId, `/api/v2/itemSearch/field?${params.toString()}`);
    const list = Array.isArray(json.data) ? json.data : [];

    for (const item of list) {
      const id = searchResultId(item);
      if (!id) continue;

      const org = await getOrganization(companyId, id, field);
      const fieldValue = normalizeCnpj(org?.custom_fields?.[field] ?? '');
      if (fieldValue === cnpj) {
        return {
          id: Number(org.id),
          name: org.name,
          cnpj: fieldValue,
          fieldKey: field
        };
      }
    }
  }

  return { id: null, name: null, cnpj, fieldKey: field };
}

async function linkOrganizationToDeal(companyId, dealId, organizationId) {
  const json = await pipedriveRequest(companyId, `/api/v2/deals/${encodeURIComponent(dealId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ org_id: Number(organizationId) })
  });
  return json.data;
}

async function createOrganization(companyId, name, cnpj, fieldKey) {
  const json = await pipedriveRequest(companyId, '/api/v2/organizations', {
    method: 'POST',
    body: JSON.stringify({
      name: String(name).trim(),
      custom_fields: {
        [fieldKey]: normalizeCnpj(cnpj)
      }
    })
  });
  return json.data;
}

function apiError(res, error) {
  console.error(error);
  res.status(error.status || 500).json({
    ok: false,
    error: error.message || 'Erro inesperado.'
  });
}

app.get('/health', async (_req, res) => {
  let database = false;
  if (pool) {
    try {
      await pool.query('SELECT 1');
      database = true;
    } catch (_) {
      database = false;
    }
  }

  res.json({
    ok: true,
    database,
    pipedriveConfigured: Boolean(CLIENT_ID && CLIENT_SECRET && CALLBACK_URL),
    callbackUrl: CALLBACK_URL || null
  });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
  <html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pipedrive CNPJ MVP</title><style>body{font-family:Arial,sans-serif;max-width:720px;margin:60px auto;padding:0 24px;color:#252525}code{background:#f3f3f3;padding:3px 6px;border-radius:4px}</style></head>
  <body><h1>Pipedrive CNPJ MVP</h1><p>Serviço online.</p><p>Modal: <code>/modal</code></p><p>OAuth callback: <code>/oauth/callback</code></p><p>Health: <code>/health</code></p></body></html>`);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    assertConfig();

    if (req.query.error) {
      return res.status(400).send(`Autorização recusada: ${String(req.query.error)}`);
    }

    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Callback recebido sem authorization code.');

    const tokens = await exchangeAuthorizationCode(code);

    const meResponse = await fetch(`${tokens.api_domain}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const meJson = await meResponse.json().catch(() => ({}));
    if (!meResponse.ok || meJson.success === false || !meJson.data) {
      throw new Error(meJson.error || 'Não foi possível identificar a empresa após o OAuth.');
    }

    const companyId = meJson.data.company_id;
    const userId = meJson.data.id;
    const expiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);

    await pool.query(
      `INSERT INTO pipedrive_oauth
        (company_id, user_id, access_token, refresh_token, api_domain, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (company_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         api_domain = EXCLUDED.api_domain,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [companyId, userId, tokens.access_token, tokens.refresh_token, tokens.api_domain, expiresAt]
    );

    res.type('html').send(`<!doctype html>
      <html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Aplicativo instalado</title><style>body{font-family:Arial,sans-serif;background:#f7f7f7;margin:0;padding:40px}.box{max-width:620px;margin:auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 3px 16px #0001}.ok{font-size:42px}h1{margin:8px 0 12px}</style></head>
      <body><div class="box"><div class="ok">✅</div><h1>Aplicativo autorizado</h1><p>A autorização do Pipedrive foi concluída e os tokens foram armazenados no banco do MVP.</p><p>Você já pode voltar ao Pipedrive, atualizar a página e abrir um negócio para testar <strong>Cadastrar / Vincular empresa</strong>.</p></div></body></html>`);
  } catch (error) {
    console.error('OAuth callback:', error);
    res.status(500).type('html').send(`<h2>Erro no OAuth</h2><pre>${String(error.message || error)}</pre>`);
  }
});

app.get('/modal', (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) {
      return res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>body{font-family:Arial;padding:28px;color:#333}</style></head><body><h2>Modal CNPJ</h2><p>Esta página deve ser aberta pelo menu de ações de um negócio dentro do Pipedrive.</p></body></html>`);
    }
    verifyExtensionToken(token);
    res.sendFile(path.join(__dirname, 'public', 'modal.html'));
  } catch (error) {
    res.status(401).type('html').send(`<h3>Não foi possível validar o modal.</h3><p>${String(error.message || error)}</p>`);
  }
});

app.post('/api/check-cnpj', async (req, res) => {
  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);

    const companyId = String(req.body.companyId || '');
    const cnpj = normalizeCnpj(req.body.cnpj);
    if (!companyId) return res.status(400).json({ ok: false, error: 'companyId não informado.' });
    validateCompanyAgainstToken(payload, companyId);

    if (!isValidCnpj(cnpj)) {
      return res.status(422).json({ ok: false, error: 'CNPJ inválido.', cnpj });
    }

    const existing = await searchOrganizationByCnpj(companyId, cnpj);
    return res.json({
      ok: true,
      valid: true,
      exists: Boolean(existing.id),
      cnpj,
      formattedCnpj: formatCnpj(cnpj),
      organization: existing.id ? { id: existing.id, name: existing.name } : null
    });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/create-link', async (req, res) => {
  let reservationMade = false;
  let companyId;
  let cnpj;

  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);

    companyId = String(req.body.companyId || '');
    const dealId = String(req.body.dealId || '');
    cnpj = normalizeCnpj(req.body.cnpj);
    const name = String(req.body.name || '').trim();

    if (!companyId || !dealId) {
      return res.status(400).json({ ok: false, error: 'companyId/dealId não informados.' });
    }
    validateCompanyAgainstToken(payload, companyId);

    if (!isValidCnpj(cnpj)) {
      return res.status(422).json({ ok: false, error: 'CNPJ inválido.' });
    }

    // Revalida imediatamente antes de criar para evitar duplicidade por tela desatualizada.
    const existing = await searchOrganizationByCnpj(companyId, cnpj);
    if (existing.id) {
      await linkOrganizationToDeal(companyId, dealId, existing.id);
      await pool.query(
        `INSERT INTO cnpj_registry (company_id, cnpj, organization_id, status, updated_at)
         VALUES ($1,$2,$3,'ready',NOW())
         ON CONFLICT (company_id, cnpj) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           status = 'ready',
           updated_at = NOW()`,
        [companyId, cnpj, existing.id]
      );

      return res.json({
        ok: true,
        action: 'linked_existing',
        organization: { id: existing.id, name: existing.name },
        dealId: Number(dealId)
      });
    }

    if (!name) {
      return res.status(422).json({ ok: false, error: 'Informe a Razão Social para criar a organização.' });
    }

    const reserve = await pool.query(
      `INSERT INTO cnpj_registry (company_id, cnpj, status, updated_at)
       VALUES ($1,$2,'creating',NOW())
       ON CONFLICT (company_id, cnpj) DO NOTHING
       RETURNING company_id`,
      [companyId, cnpj]
    );

    if (!reserve.rows.length) {
      const current = await pool.query(
        'SELECT organization_id, status FROM cnpj_registry WHERE company_id=$1 AND cnpj=$2',
        [companyId, cnpj]
      );
      const row = current.rows[0];
      if (row?.organization_id) {
        await linkOrganizationToDeal(companyId, dealId, row.organization_id);
        const org = await getOrganization(companyId, row.organization_id, await getCnpjFieldKey(companyId));
        return res.json({
          ok: true,
          action: 'linked_existing',
          organization: { id: Number(row.organization_id), name: org?.name || `Organização ${row.organization_id}` },
          dealId: Number(dealId)
        });
      }

      const err = new Error('Este CNPJ está sendo cadastrado por outro processo. Aguarde alguns segundos e tente novamente.');
      err.status = 409;
      throw err;
    }
    reservationMade = true;

    const fieldKey = await getCnpjFieldKey(companyId);
    const organization = await createOrganization(companyId, name, cnpj, fieldKey);
    await linkOrganizationToDeal(companyId, dealId, organization.id);

    await pool.query(
      `UPDATE cnpj_registry
          SET organization_id=$3, status='ready', updated_at=NOW()
        WHERE company_id=$1 AND cnpj=$2`,
      [companyId, cnpj, organization.id]
    );

    return res.json({
      ok: true,
      action: 'created_and_linked',
      organization: { id: Number(organization.id), name: organization.name },
      dealId: Number(dealId)
    });
  } catch (error) {
    if (reservationMade && pool && companyId && cnpj) {
      try {
        await pool.query(
          `DELETE FROM cnpj_registry
            WHERE company_id=$1 AND cnpj=$2 AND status='creating' AND organization_id IS NULL`,
          [companyId, cnpj]
        );
      } catch (_) {}
    }
    apiError(res, error);
  }
});

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Pipedrive CNPJ MVP ouvindo na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Falha ao inicializar banco:', error);
    process.exit(1);
  });
