require('dotenv').config();

const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
const PORT = process.env.PORT || 10000;

const CLIENT_ID = process.env.PIPEDRIVE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PIPEDRIVE_CLIENT_SECRET || '';
const JWT_SECRET = process.env.PIPEDRIVE_JWT_SECRET || CLIENT_SECRET;
const CALLBACK_URL = process.env.PIPEDRIVE_CALLBACK_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const CNPJ_FIELD_KEY_ENV = process.env.PIPEDRIVE_CNPJ_FIELD_KEY || '';
const TRADE_NAME_FIELD_KEY_ENV = process.env.PIPEDRIVE_TRADE_NAME_FIELD_KEY || '';
const ORG_EMAIL_FIELD_KEY_ENV = process.env.PIPEDRIVE_ORG_EMAIL_FIELD_KEY || '';
const BRASIL_API_CNPJ_URL = 'https://brasilapi.com.br/api/cnpj/v1';
const CNPJ_WS_PUBLIC_URL = 'https://publica.cnpj.ws/cnpj';

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const requestContext = new AsyncLocalStorage();

app.use(express.json({ limit: '300kb' }));
app.use('/assets', express.static(path.join(__dirname, 'public')));

// v6.4: mantém o usuário logado no contexto assíncrono de cada requisição.
// Assim todas as chamadas internas ao Pipedrive usam o OAuth desse mesmo usuário.
app.use('/api', (req, res, next) => {
  try {
    const token = req.get('x-pipedrive-token') || req.body?.token || req.query?.token;
    const payload = verifyExtensionToken(token);
    const userId = resolveLoggedUserId(payload, req.body?.userId || req.query?.userId);
    const companyId = String(req.body?.companyId || req.query?.companyId || companyIdFromPayload(payload) || '');
    if (!companyId) {
      const err = new Error('Não foi possível identificar a empresa do Pipedrive.');
      err.status = 400;
      throw err;
    }
    validateCompanyAgainstToken(payload, companyId);
    requestContext.run({ userId, companyId }, next);
  } catch (error) {
    apiError(res, error);
  }
});

function assertConfig() {
  const missing = [];
  if (!CLIENT_ID) missing.push('PIPEDRIVE_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('PIPEDRIVE_CLIENT_SECRET');
  if (!CALLBACK_URL) missing.push('PIPEDRIVE_CALLBACK_URL');
  if (!DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length) throw new Error(`Configuração ausente: ${missing.join(', ')}`);
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

  // Colunas legadas da v6.3 são preservadas apenas para compatibilidade com bancos existentes.
  await pool.query(`ALTER TABLE pipedrive_oauth ADD COLUMN IF NOT EXISTS technical_locked BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE pipedrive_oauth ADD COLUMN IF NOT EXISTS technical_user_name TEXT`);
  await pool.query(`ALTER TABLE pipedrive_oauth ADD COLUMN IF NOT EXISTS technical_user_email TEXT`);

  // v6.4: OAuth individual por usuário. Cada usuário autoriza a aplicação e
  // as chamadas feitas pela extensão usam o token desse próprio usuário.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipedrive_oauth_user (
      company_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      user_name TEXT,
      user_email TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      api_domain TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pipedrive_oauth_user_company ON pipedrive_oauth_user(company_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cnpj_registry (
      company_id BIGINT NOT NULL,
      cnpj VARCHAR(14) NOT NULL,
      organization_id BIGINT,
      status VARCHAR(30) NOT NULL DEFAULT 'creating',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, cnpj)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cnpj_lookup_cache (
      cnpj VARCHAR(14) PRIMARY KEY,
      payload JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_creation_registry (
      request_id VARCHAR(80) PRIMARY KEY,
      company_id BIGINT NOT NULL,
      organization_id BIGINT NOT NULL,
      person_id BIGINT,
      deal_id BIGINT,
      status VARCHAR(30) NOT NULL DEFAULT 'creating',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_audit_log (
      id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL,
      actor_user_id BIGINT,
      technical_user_id BIGINT,
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(40),
      entity_id BIGINT,
      cnpj VARCHAR(14),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE app_audit_log ADD COLUMN IF NOT EXISTS execution_user_id BIGINT`);
  await pool.query(`ALTER TABLE app_audit_log ADD COLUMN IF NOT EXISTS actor_user_name TEXT`);
  await pool.query(`ALTER TABLE app_audit_log ADD COLUMN IF NOT EXISTS actor_user_email TEXT`);
  await pool.query(`ALTER TABLE app_audit_log ADD COLUMN IF NOT EXISTS note_id BIGINT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_audit_company_created ON app_audit_log(company_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_audit_cnpj ON app_audit_log(company_id, cnpj)`);
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

// Compatível com CNPJ numérico legado e CNPJ alfanumérico.
// Nas 12 posições-base, o valor de cada caractere é ASCII - 48; os 2 DVs seguem numéricos.
function isValidCnpj(value) {
  const cnpj = normalizeCnpj(value);
  if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj)) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const charValue = (ch) => ch.charCodeAt(0) - 48;
  const calc = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i += 1) sum += charValue(base[i]) * weights[i];
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

function userIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.userId ?? payload.user_id ?? payload.user?.id ?? payload.pipedrive_user_id ?? null;
}

function resolveLoggedUserId(payload, providedUserId) {
  const tokenUserId = userIdFromPayload(payload);
  const requestedUserId = Number(providedUserId || tokenUserId || 0);

  if (!requestedUserId) {
    const err = new Error('Não foi possível identificar o usuário logado no Pipedrive.');
    err.status = 401;
    throw err;
  }

  if (tokenUserId != null && String(tokenUserId) !== String(requestedUserId)) {
    const err = new Error('Usuário do token não corresponde ao usuário informado pela extensão.');
    err.status = 403;
    throw err;
  }

  return requestedUserId;
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
  if (!response.ok) throw new Error(data.error_description || data.error || `OAuth HTTP ${response.status}`);
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
  if (!response.ok) throw new Error(data.error_description || data.error || `Falha ao renovar OAuth (${response.status})`);

  const expiresAt = new Date(Date.now() + Number(data.expires_in || 3600) * 1000);
  const updated = await pool.query(
    `UPDATE pipedrive_oauth_user
       SET access_token = $3,
           refresh_token = $4,
           api_domain = $5,
           expires_at = $6,
           updated_at = NOW()
     WHERE company_id = $1 AND user_id = $2
     RETURNING *`,
    [row.company_id, row.user_id, data.access_token, data.refresh_token, data.api_domain || row.api_domain, expiresAt]
  );

  return updated.rows[0];
}

async function getOauth(companyId) {
  if (!pool) throw new Error('DATABASE_URL não configurada.');

  const ctx = requestContext.getStore() || {};
  const userId = Number(ctx.userId || 0);
  if (!userId) {
    const err = new Error('Não foi possível identificar o usuário logado para selecionar o OAuth individual.');
    err.status = 401;
    err.code = 'USER_CONTEXT_REQUIRED';
    throw err;
  }

  const result = await pool.query(
    'SELECT * FROM pipedrive_oauth_user WHERE company_id = $1 AND user_id = $2',
    [companyId, userId]
  );
  if (!result.rows.length) {
    const err = new Error('Seu usuário ainda não autorizou a aplicação Validação CNPJ. Instale/autorize a aplicação com o seu próprio login do Pipedrive e tente novamente.');
    err.status = 401;
    err.code = 'USER_OAUTH_REQUIRED';
    throw err;
  }

  let row = result.rows[0];
  const expires = new Date(row.expires_at).getTime();
  if (expires <= Date.now() + 120000) row = await refreshOauth(row);
  return row;
}

async function writeAudit({ companyId, actorUserId = null, action, entityType = null, entityId = null, cnpj = '', details = {}, noteId = null }) {
  if (!pool || !companyId || !action) return;
  try {
    let actorName = null;
    let actorEmail = null;
    if (actorUserId) {
      const oauthUser = await pool.query(
        'SELECT user_name, user_email FROM pipedrive_oauth_user WHERE company_id=$1 AND user_id=$2',
        [companyId, Number(actorUserId)]
      );
      actorName = oauthUser.rows[0]?.user_name || null;
      actorEmail = oauthUser.rows[0]?.user_email || null;
    }

    await pool.query(
      `INSERT INTO app_audit_log
        (company_id, actor_user_id, technical_user_id, execution_user_id, actor_user_name, actor_user_email, action, entity_type, entity_id, cnpj, details, note_id, created_at)
       VALUES ($1,$2,NULL,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,NOW())`,
      [
        companyId,
        actorUserId ? Number(actorUserId) : null,
        actorName,
        actorEmail,
        clean(action, 80),
        entityType ? clean(entityType, 40) : null,
        entityId ? Number(entityId) : null,
        normalizeCnpj(cnpj) || null,
        JSON.stringify({ ...(details || {}), oauthMode: 'individual-user' }),
        noteId ? Number(noteId) : null
      ]
    );
  } catch (error) {
    console.error('Falha ao gravar auditoria:', error);
  }
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

function escapeHtmlServer(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function createVisibleAuditNote(companyId, actorUserId, dealId, cnpj, organizationId, personId) {
  const oauth = await getOauth(companyId);
  const actorName = oauth.user_name || `Usuário #${actorUserId}`;
  const when = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const content = [
    '<strong>Cadastro realizado via Validação CNPJ</strong>',
    `Solicitado/executado por: ${escapeHtmlServer(actorName)} (API)`,
    `CNPJ: ${escapeHtmlServer(formatCnpj(cnpj))}`,
    `Organização: #${Number(organizationId)}`,
    `Contato: #${Number(personId)}`,
    `Negócio: #${Number(dealId)}`,
    `Data/hora: ${escapeHtmlServer(when)}`
  ].join('<br>');

  const json = await pipedriveRequest(companyId, '/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify({
      content,
      deal_id: Number(dealId),
      pinned_to_deal_flag: 1
    })
  });
  return json?.data || null;
}

function normalizeFieldName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function getOrganizationFields(companyId) {
  const fields = await pipedriveRequest(companyId, '/api/v2/organizationFields?limit=500');
  return Array.isArray(fields.data) ? fields.data : [];
}

function organizationFieldName(field) {
  return field?.name || field?.field_name || '';
}

function findOrganizationField(fields, acceptedNames) {
  const accepted = new Set(acceptedNames.map(normalizeFieldName));
  return fields.find((field) => accepted.has(normalizeFieldName(organizationFieldName(field)))) || null;
}

function fieldKey(field) {
  return field?.field_code || field?.key || field?.code || null;
}

async function getCnpjFieldKey(companyId) {
  if (CNPJ_FIELD_KEY_ENV) return CNPJ_FIELD_KEY_ENV;

  const list = await getOrganizationFields(companyId);
  const exact = list.find((f) => normalizeFieldName(f.name || f.field_name) === 'cnpj');
  const candidate = exact || list.find((f) => normalizeFieldName(f.name || f.field_name).includes('cnpj'));

  if (!candidate) {
    const err = new Error('Não encontrei um campo de Organização chamado CNPJ no Pipedrive.');
    err.status = 422;
    throw err;
  }

  const key = fieldKey(candidate);
  if (!key) throw new Error('Campo CNPJ encontrado, mas a chave do campo não veio na resposta da API.');
  return key;
}

async function getTradeNameFieldKey(companyId) {
  if (TRADE_NAME_FIELD_KEY_ENV) return TRADE_NAME_FIELD_KEY_ENV;

  const list = await getOrganizationFields(companyId);
  const candidate = findOrganizationField(list, ['Nome Fantasia', 'Fantasia'])
    || list.find((f) => normalizeFieldName(organizationFieldName(f)).includes('nomefantasia'));

  return candidate ? fieldKey(candidate) : null;
}

async function getOrganizationEmailFieldKey(companyId) {
  if (ORG_EMAIL_FIELD_KEY_ENV) return ORG_EMAIL_FIELD_KEY_ENV;

  const list = await getOrganizationFields(companyId);
  const candidate = findOrganizationField(list, [
    'E-mail',
    'Email',
    'Endereço Eletrônico',
    'Endereco Eletronico',
    'E-mail da Organização',
    'Email da Organização'
  ]);

  return candidate ? fieldKey(candidate) : null;
}

function normalizeDateForPipedrive(value) {
  const raw = clean(value, 40);
  if (!raw) return '';

  // BrasilAPI normalmente devolve YYYY-MM-DD.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;

  // Fallback para DD/MM/YYYY.
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;

  return '';
}

function formatDateBr(value) {
  const iso = normalizeDateForPipedrive(value);
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function formatQsa(qsa) {
  if (!Array.isArray(qsa) || !qsa.length) return '';

  return qsa
    .map((item) => {
      const name = clean(item?.nome_socio, 255);
      if (!name) return null;

      const qualification = clean(item?.qualificacao_socio, 180);
      const entryDate = formatDateBr(item?.data_entrada_sociedade);

      const parts = [name];
      if (qualification) parts.push(qualification);
      if (entryDate) parts.push(`Entrada: ${entryDate}`);

      return parts.join(' — ');
    })
    .filter(Boolean)
    .join('\n');
}

function resolveEnumOptionId(field, desiredLabel) {
  if (!field || !desiredLabel) return null;
  const desired = normalizeFieldName(desiredLabel);
  const options = Array.isArray(field.options) ? field.options : [];

  const found = options.find((option) => normalizeFieldName(option?.label) === desired);
  return found?.id ?? null;
}

async function buildRegistryCustomFields(companyId, registryData) {
  const fields = await getOrganizationFields(companyId);
  const customFields = {};
  const warnings = [];

  const putText = (names, value) => {
    const cleaned = clean(value, 65000);
    if (!cleaned) return;

    const field = findOrganizationField(fields, names);
    const key = fieldKey(field);
    if (!field || !key) {
      warnings.push(`Campo "${names[0]}" não encontrado no Pipedrive.`);
      return;
    }
    customFields[key] = cleaned;
  };

  const putDate = (names, value) => {
    const normalized = normalizeDateForPipedrive(value);
    if (!normalized) return;

    const field = findOrganizationField(fields, names);
    const key = fieldKey(field);
    if (!field || !key) {
      warnings.push(`Campo "${names[0]}" não encontrado no Pipedrive.`);
      return;
    }
    customFields[key] = normalized;
  };

  const putEnum = async (names, label) => {
    const cleaned = clean(label, 120).toUpperCase();
    if (!cleaned) return;

    let field = findOrganizationField(fields, names);
    const key = fieldKey(field);
    if (!field || !key) {
      warnings.push(`Campo "${names[0]}" não encontrado no Pipedrive.`);
      return;
    }

    // Algumas respostas resumidas da Fields API podem não trazer "options".
    // Busca o campo individualmente antes de desistir.
    if (!Array.isArray(field.options) || !field.options.length) {
      try {
        const details = await pipedriveRequest(
          companyId,
          `/api/v2/organizationFields/${encodeURIComponent(key)}`
        );
        if (details?.data) field = details.data;
      } catch (_) {
        // O warning abaixo explicará caso a opção realmente não seja localizada.
      }
    }

    const optionId = resolveEnumOptionId(field, cleaned);
    if (optionId == null) {
      warnings.push(`A opção "${cleaned}" não existe no campo "${names[0]}".`);
      return;
    }

    customFields[key] = optionId;
  };

  putText(['Nome Fantasia', 'Fantasia'], registryData?.tradeName);
  await putEnum(['Situação Cadastral', 'Situacao Cadastral'], registryData?.registryStatus);
  putDate(['Data Situação Cadastral', 'Data Situacao Cadastral'], registryData?.registryStatusDate);
  putText(['CNAE Principal'], registryData?.cnae);
  putText(['Descrição CNAE Principal', 'Descricao CNAE Principal'], registryData?.cnaeDescription);
  putText(['Natureza Jurídica', 'Natureza Juridica'], registryData?.legalNature);
  putText(['Quadro Societário (QSA)', 'Quadro Societario (QSA)', 'QSA'], registryData?.qsaText);
  putText(['E-mail', 'Email', 'Endereço Eletrônico', 'Endereco Eletronico', 'E-mail da Organização', 'Email da Organização'], registryData?.email);

  return { customFields, warnings };
}

function extractSearchItems(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.items)) return json.data.items;
  return [];
}

function searchResultId(item) {
  return item?.id ?? item?.item_id ?? item?.item?.id ?? item?.result?.id ?? null;
}

async function getOrganization(companyId, organizationId, cnpjFieldKey) {
  const query = cnpjFieldKey ? `?custom_fields=${encodeURIComponent(cnpjFieldKey)}` : '';
  const json = await pipedriveRequest(
    companyId,
    `/api/v2/organizations/${encodeURIComponent(organizationId)}${query}`
  );
  return json.data;
}

async function searchOrganizationsByCnpj(companyId, rawCnpj) {
  const cnpj = normalizeCnpj(rawCnpj);
  const field = await getCnpjFieldKey(companyId);
  const formatted = formatCnpj(cnpj);

  // Usa o endpoint específico de Organizações, coberto por contacts:read/full.
  const variants = [...new Set([cnpj, formatted, cnpj.toLowerCase(), formatted.toLowerCase()])];
  const matches = new Map();

  for (const term of variants) {
    const params = new URLSearchParams({
      term,
      fields: 'custom_fields',
      exact_match: 'true',
      limit: '50'
    });

    const json = await pipedriveRequest(companyId, `/api/v2/organizations/search?${params.toString()}`);
    const list = extractSearchItems(json);

    for (const item of list) {
      const id = searchResultId(item);
      if (!id || matches.has(String(id))) continue;

      const org = await getOrganization(companyId, id, field);
      const value = normalizeCnpj(org?.custom_fields?.[field] ?? '');
      if (value === cnpj) {
        matches.set(String(id), {
          id: Number(org.id),
          name: org.name,
          cnpj: value,
          fieldKey: field,
          address: org?.address?.value || org?.address || null
        });
      }
    }
  }

  return {
    cnpj,
    fieldKey: field,
    organizations: [...matches.values()]
  };
}

async function searchOrganizationByCnpj(companyId, rawCnpj) {
  const result = await searchOrganizationsByCnpj(companyId, rawCnpj);
  const first = result.organizations[0] || null;
  return first
    ? { ...first, fieldKey: result.fieldKey }
    : { id: null, name: null, cnpj: result.cnpj, fieldKey: result.fieldKey };
}

async function getCnpjBindingByCnpj(companyId, rawCnpj) {
  if (!pool) return null;
  const cnpj = normalizeCnpj(rawCnpj);
  const result = await pool.query(
    `SELECT company_id, cnpj, organization_id, status
       FROM cnpj_registry
      WHERE company_id=$1 AND cnpj=$2`,
    [companyId, cnpj]
  );
  return result.rows[0] || null;
}

async function getCnpjBindingByOrganization(companyId, organizationId) {
  if (!pool || !organizationId) return null;
  const result = await pool.query(
    `SELECT company_id, cnpj, organization_id, status
       FROM cnpj_registry
      WHERE company_id=$1 AND organization_id=$2
      ORDER BY updated_at DESC
      LIMIT 1`,
    [companyId, Number(organizationId)]
  );
  return result.rows[0] || null;
}

function cnpjLockError(code, message) {
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  return err;
}

async function bindCnpjToOrganization(companyId, rawCnpj, organizationId) {
  const cnpj = normalizeCnpj(rawCnpj);
  const orgId = Number(organizationId);
  if (!isValidCnpj(cnpj) || !orgId) throw new Error('Vínculo CNPJ/Organização inválido.');

  const boundOrg = await getCnpjBindingByOrganization(companyId, orgId);
  if (boundOrg && normalizeCnpj(boundOrg.cnpj) !== cnpj) {
    throw cnpjLockError(
      'ORG_CNPJ_LOCKED',
      `A Organização #${orgId} já está vinculada ao CNPJ ${formatCnpj(boundOrg.cnpj)}. O CNPJ não pode ser substituído.`
    );
  }

  const boundCnpj = await getCnpjBindingByCnpj(companyId, cnpj);
  if (boundCnpj?.organization_id && Number(boundCnpj.organization_id) !== orgId) {
    throw cnpjLockError(
      'CNPJ_BOUND_TO_OTHER_ORG',
      `O CNPJ ${formatCnpj(cnpj)} já está vinculado à Organização #${boundCnpj.organization_id}.`
    );
  }

  await pool.query(
    `INSERT INTO cnpj_registry (company_id, cnpj, organization_id, status, updated_at)
     VALUES ($1,$2,$3,'ready',NOW())
     ON CONFLICT (company_id, cnpj) DO UPDATE SET
       organization_id=COALESCE(cnpj_registry.organization_id, EXCLUDED.organization_id),
       status='ready',
       updated_at=NOW()`,
    [companyId, cnpj, orgId]
  );
}

async function verifyOrganizationCnpj(companyId, organizationId, rawExpectedCnpj) {
  const expectedCnpj = normalizeCnpj(rawExpectedCnpj);
  if (!isValidCnpj(expectedCnpj)) {
    throw cnpjLockError('CNPJ_REQUIRED_FOR_LOCK', 'Revalide o CNPJ antes de continuar.');
  }

  const cnpjFieldKey = await getCnpjFieldKey(companyId);
  const organization = await getOrganization(companyId, organizationId, cnpjFieldKey);
  const currentCnpj = normalizeCnpj(organization?.custom_fields?.[cnpjFieldKey] || '');

  if (!currentCnpj) {
    throw cnpjLockError(
      'CNPJ_MISSING_ON_ORG',
      `A Organização #${organizationId} está sem CNPJ. Por segurança, o aplicativo não vai preencher nem substituir esse campo automaticamente.`
    );
  }

  if (currentCnpj !== expectedCnpj) {
    throw cnpjLockError(
      'CNPJ_IMMUTABLE_MISMATCH',
      `O CNPJ da Organização #${organizationId} foi alterado fora do fluxo validado. Esperado: ${formatCnpj(expectedCnpj)}. Atual: ${formatCnpj(currentCnpj)}. Restaure o CNPJ correto antes de continuar.`
    );
  }

  await bindCnpjToOrganization(companyId, expectedCnpj, organizationId);
  return organization;
}

function buildBrasilApiAddress(data) {
  const parts = [];
  if (data.logradouro) parts.push(clean(data.logradouro, 250));
  if (data.numero) parts.push(clean(data.numero, 50));
  if (data.bairro) parts.push(clean(data.bairro, 100));
  if (data.complemento) parts.push(clean(data.complemento, 150));
  return parts.filter(Boolean).join(', ');
}


async function getCachedBrasilApiCnpj(cnpj) {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT payload
       FROM cnpj_lookup_cache
      WHERE cnpj=$1
        AND fetched_at >= NOW() - INTERVAL '24 hours'`,
    [cnpj]
  );
  return result.rows[0]?.payload || null;
}

async function saveCachedBrasilApiCnpj(cnpj, payload) {
  if (!pool || !payload?.found) return;
  await pool.query(
    `INSERT INTO cnpj_lookup_cache (cnpj, payload, fetched_at)
     VALUES ($1,$2::jsonb,NOW())
     ON CONFLICT (cnpj)
     DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`,
    [cnpj, JSON.stringify(payload)]
  );
}

async function lookupCnpjWsEmail(cnpj) {
  // A API pública do CNPJ.ws atualmente trabalha com CNPJ numérico.
  // Usamos apenas como fallback quando a BrasilAPI não devolve e-mail.
  if (!/^\d{14}$/.test(cnpj)) return { email: '', source: '' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(`${CNPJ_WS_PUBLIC_URL}/${encodeURIComponent(cnpj)}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Pipedrive-CNPJ/6.2'
      },
      signal: controller.signal
    });

    if (!response.ok) return { email: '', source: '' };

    const data = await response.json().catch(() => ({}));
    const email = normalizeEmail(data?.estabelecimento?.email || '');
    return {
      email: isValidEmail(email) ? email : '',
      source: email ? 'CNPJ.ws' : ''
    };
  } catch (_) {
    // Fallback não pode impedir o cadastro caso o serviço esteja indisponível.
    return { email: '', source: '' };
  } finally {
    clearTimeout(timeout);
  }
}

async function fillMissingRegistryEmail(cnpj, registry) {
  if (!registry?.found || !registry?.data) return { registry, changed: false };

  const currentEmail = normalizeEmail(registry.data.email || '');
  if (isValidEmail(currentEmail)) {
    registry.data.email = currentEmail;
    registry.data.emailSource = registry.data.emailSource || 'BrasilAPI';
    return { registry, changed: false };
  }

  const fallback = await lookupCnpjWsEmail(cnpj);
  if (!fallback.email) return { registry, changed: false };

  registry.data.email = fallback.email;
  registry.data.emailSource = fallback.source;
  return { registry, changed: true };
}

async function lookupBrasilApiCnpj(rawCnpj, { force = false, withEmailFallback = true } = {}) {
  const cnpj = normalizeCnpj(rawCnpj);

  if (!force) {
    const cached = await getCachedBrasilApiCnpj(cnpj);
    if (cached) {
      // Corrige também caches antigos que ficaram salvos sem e-mail.
      if (!withEmailFallback) return cached;
      const enriched = await fillMissingRegistryEmail(cnpj, cached);
      if (enriched.changed) await saveCachedBrasilApiCnpj(cnpj, enriched.registry);
      return enriched.registry;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${BRASIL_API_CNPJ_URL}/${encodeURIComponent(cnpj)}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Pipedrive-CNPJ/6.2'
      },
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 404) {
      return {
        found: false,
        unavailable: false,
        warning: 'CNPJ não localizado na base consultada pela BrasilAPI.'
      };
    }

    if (!response.ok) {
      const objectError = data?.error && typeof data.error === 'object'
        ? (data.error.message || data.error.description || JSON.stringify(data.error))
        : null;
      const warning = typeof data?.message === 'string'
        ? data.message
        : (typeof data?.error === 'string'
          ? data.error
          : (objectError || `BrasilAPI indisponível (HTTP ${response.status}).`));

      return {
        found: false,
        unavailable: true,
        warning
      };
    }

    const status = clean(data.descricao_situacao_cadastral, 80).toUpperCase();
    const phone = clean(data.ddd_telefone_1 || data.ddd_telefone_2, 100);
    const email = normalizeEmail(data.email);

    let result = {
      found: true,
      unavailable: false,
      status,
      active: status === 'ATIVA',
      data: {
        cnpj,
        legalName: clean(data.razao_social, 255),
        tradeName: clean(data.nome_fantasia, 255),
        postalCode: clean(data.cep, 20),
        state: clean(data.uf, 2).toUpperCase(),
        city: clean(data.municipio, 100),
        addressLine: buildBrasilApiAddress(data),
        phone,
        email,
        emailSource: email ? 'BrasilAPI' : '',
        cnae: data.cnae_fiscal ? String(data.cnae_fiscal) : '',
        cnaeDescription: clean(data.cnae_fiscal_descricao, 255),
        registryStatus: status,
        registryStatusDate: clean(data.data_situacao_cadastral, 30),
        registryReason: clean(data.descricao_motivo_situacao_cadastral, 255),
        matrixBranch: clean(data.descricao_identificador_matriz_filial, 80),
        legalNature: clean(data.natureza_juridica, 255),
        qsaCount: Array.isArray(data.qsa) ? data.qsa.length : 0,
        qsaText: formatQsa(data.qsa)
      }
    };

    // Alguns CNPJs retornam email=null na BrasilAPI. Nesses casos, tenta
    // uma segunda fonte pública/gratuita somente para o endereço eletrônico.
    if (withEmailFallback) {
      result = (await fillMissingRegistryEmail(cnpj, result)).registry;
    }

    await saveCachedBrasilApiCnpj(cnpj, result);
    return result;
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Tempo esgotado ao consultar a BrasilAPI.'
      : `Não foi possível consultar a BrasilAPI: ${error.message || error}`;

    return { found: false, unavailable: true, warning: message };
  } finally {
    clearTimeout(timeout);
  }
}

function clean(value, max = 255) {
  return String(value || '').trim().slice(0, max);
}

function normalizeEmail(value) {
  return clean(value, 255).toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function createOrganization(companyId, data, cnpj, cnpjFieldKey, registryData = null, ownerId = null) {
  const legalName = clean(data.legalName);
  const tradeName = clean(data.tradeName);
  const addressLine = clean(data.addressLine, 500);
  const postalCode = clean(data.postalCode, 30);
  const city = clean(data.city, 100);
  const state = clean(data.state, 100).toUpperCase();
  const confirmedOrganizationEmail = normalizeEmail(data.organizationEmail || '');
  const registryOrganizationEmail = normalizeEmail(registryData?.email || '');
  const organizationEmail = confirmedOrganizationEmail || registryOrganizationEmail;

  const customFields = { [cnpjFieldKey]: normalizeCnpj(cnpj) };
  const warnings = [];

  // Na v4, quando a BrasilAPI respondeu, os dados cadastrais oficiais da consulta
  // são usados para preencher os campos personalizados da Organização.
  if (registryData) {
    const registryFields = await buildRegistryCustomFields(companyId, registryData);
    Object.assign(customFields, registryFields.customFields);
    warnings.push(...registryFields.warnings);
  } else {
    // Fallback manual: ao menos tenta salvar Nome Fantasia.
    const tradeNameFieldKey = tradeName ? await getTradeNameFieldKey(companyId) : null;
    if (tradeName && tradeNameFieldKey) {
      customFields[tradeNameFieldKey] = tradeName;
    } else if (tradeName) {
      warnings.push('Nome Fantasia não foi salvo porque o campo não foi encontrado.');
    }
  }

  // Se a consulta não trouxe nome fantasia, preserva o valor confirmado pelo usuário.
  if (tradeName && registryData && !registryData.tradeName) {
    const tradeNameFieldKey = await getTradeNameFieldKey(companyId);
    if (tradeNameFieldKey) customFields[tradeNameFieldKey] = tradeName;
  }

  // A Organização não possui e-mail nativo na API v2. Salvamos no campo personalizado
  // "E-mail" / "Endereço Eletrônico" quando ele existir no Pipedrive.
  // Se o usuário editou o e-mail cadastral (ou se estamos em preenchimento manual),
  // o valor confirmado na tela prevalece sobre o retornado pela BrasilAPI.
  if (organizationEmail && (!registryData || organizationEmail !== registryOrganizationEmail)) {
    const organizationEmailFieldKey = await getOrganizationEmailFieldKey(companyId);
    if (organizationEmailFieldKey) {
      customFields[organizationEmailFieldKey] = organizationEmail;
    } else {
      warnings.push('E-mail da Organização não foi salvo porque o campo personalizado "E-mail"/"Endereço Eletrônico" não foi encontrado.');
    }
  }

  const body = {
    name: legalName,
    custom_fields: customFields
  };
  if (ownerId) body.owner_id = Number(ownerId);

  if (addressLine || postalCode || city || state) {
    body.address = {
      value: addressLine || [city, state].filter(Boolean).join(' - '),
      country: 'Brasil',
      admin_area_level_1: state || undefined,
      locality: city || undefined,
      postal_code: postalCode || undefined
    };
  }

  const json = await pipedriveRequest(companyId, '/api/v2/organizations', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  return {
    organization: json.data,
    warnings
  };
}

async function createPerson(companyId, organizationId, data, ownerId = null) {
  const contactName = clean(data.contactName);
  const phone = clean(data.phone, 100);
  const email = normalizeEmail(data.email);

  const body = {
    name: contactName,
    org_id: Number(organizationId),
    phones: [{ value: phone, primary: true, label: 'work' }],
    emails: [{ value: email, primary: true, label: 'work' }]
  };
  if (ownerId) body.owner_id = Number(ownerId);

  const json = await pipedriveRequest(companyId, '/api/v2/persons', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return json.data;
}

async function linkContactsToDeal(companyId, dealId, organizationId, personId = null) {
  const body = { org_id: Number(organizationId) };
  if (personId) body.person_id = Number(personId);

  const json = await pipedriveRequest(companyId, `/api/v2/deals/${encodeURIComponent(dealId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
  return json.data;
}

async function createDeal(companyId, organizationId, personId, data = {}, ownerId = null) {
  const title = clean(data.dealTitle || data.title, 255);
  if (!title) {
    const err = new Error('Informe o título do negócio.');
    err.status = 422;
    throw err;
  }

  const body = {
    title,
    org_id: Number(organizationId)
  };

  if (personId) body.person_id = Number(personId);
  if (ownerId) body.owner_id = Number(ownerId);

  const normalizedValue = String(data.dealValue ?? '').trim().replace(',', '.');
  const value = normalizedValue ? Number(normalizedValue) : NaN;
  if (Number.isFinite(value) && value > 0) {
    body.value = value;
    body.currency = clean(data.currency || 'BRL', 3).toUpperCase() || 'BRL';
  }

  const json = await pipedriveRequest(companyId, '/api/v2/deals', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return json.data;
}

async function createDealIdempotent(companyId, organizationId, personId, data = {}, ownerId = null) {
  const requestId = clean(data.requestId, 80);
  if (!requestId) {
    const err = new Error('requestId não informado para criação segura do negócio.');
    err.status = 400;
    throw err;
  }

  const current = await pool.query(
    `SELECT deal_id, status
       FROM deal_creation_registry
      WHERE request_id=$1`,
    [requestId]
  );

  if (current.rows[0]?.deal_id) {
    const deal = await pipedriveRequest(companyId, `/api/v2/deals/${current.rows[0].deal_id}`);
    return { deal: deal.data, reused: true };
  }

  const reserve = await pool.query(
    `INSERT INTO deal_creation_registry
      (request_id, company_id, organization_id, person_id, status, updated_at)
     VALUES ($1,$2,$3,$4,'creating',NOW())
     ON CONFLICT (request_id) DO NOTHING
     RETURNING request_id`,
    [requestId, companyId, organizationId, personId || null]
  );

  if (!reserve.rows.length) {
    const again = await pool.query(
      `SELECT deal_id, status FROM deal_creation_registry WHERE request_id=$1`,
      [requestId]
    );
    if (again.rows[0]?.deal_id) {
      const deal = await pipedriveRequest(companyId, `/api/v2/deals/${again.rows[0].deal_id}`);
      return { deal: deal.data, reused: true };
    }
    const err = new Error('A criação deste negócio já está em andamento. Aguarde alguns segundos.');
    err.status = 409;
    throw err;
  }

  try {
    const deal = await createDeal(companyId, organizationId, personId, data, ownerId);
    await pool.query(
      `UPDATE deal_creation_registry
          SET deal_id=$2, status='created', updated_at=NOW()
        WHERE request_id=$1`,
      [requestId, deal.id]
    );
    return { deal, reused: false };
  } catch (error) {
    await pool.query(
      `DELETE FROM deal_creation_registry
        WHERE request_id=$1 AND deal_id IS NULL`,
      [requestId]
    ).catch(() => {});
    throw error;
  }
}

function validateNewCompanyPayload(body) {
  const legalName = clean(body.legalName);
  const contactName = clean(body.contactName);
  const phone = clean(body.phone, 100);
  const email = normalizeEmail(body.email);
  const organizationEmail = normalizeEmail(body.organizationEmail);

  if (!legalName) return 'Informe a Razão Social.';
  if (!contactName) return 'Informe o nome do contato principal.';
  if (!phone) return 'Informe o telefone do contato principal.';
  if (!isValidEmail(email)) return 'Informe um e-mail válido para o contato principal.';
  if (body.organizationEmail && !isValidEmail(organizationEmail)) return 'Informe um e-mail válido para a Organização.';
  return null;
}

function apiError(res, error) {
  console.error(error);
  res.status(error.status || 500).json({
    ok: false,
    ...(error.code ? { code: error.code } : {}),
    error: error.message || 'Erro inesperado.'
  });
}

app.get('/health', async (_req, res) => {
  let database = false;
  let authorizedUsers = 0;
  if (pool) {
    try {
      await pool.query('SELECT 1');
      database = true;
      const users = await pool.query('SELECT COUNT(*)::int AS total FROM pipedrive_oauth_user');
      authorizedUsers = Number(users.rows[0]?.total || 0);
    } catch (_) {
      database = false;
    }
  }

  res.json({
    ok: true,
    database,
    pipedriveConfigured: Boolean(CLIENT_ID && CLIENT_SECRET && CALLBACK_URL),
    oauthMode: 'individual-user',
    authorizedUsers,
    callbackUrl: CALLBACK_URL || null,
    version: '6.4.1'
  });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
  <html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pipedrive CNPJ MVP</title><style>body{font-family:Arial,sans-serif;max-width:720px;margin:60px auto;padding:0 24px;color:#252525}code{background:#f3f3f3;padding:3px 6px;border-radius:4px}</style></head>
  <body><h1>Pipedrive CNPJ MVP v6.4.1</h1><p>Serviço online.</p><p>Janela flutuante: <code>/floating</code></p><p>Modal legado: <code>/modal</code></p><p>OAuth callback: <code>/oauth/callback</code></p><p>Health: <code>/health</code></p></body></html>`);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    assertConfig();

    if (req.query.error) return res.status(400).send(`Autorização recusada: ${String(req.query.error)}`);

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
    const userName = clean(meJson.data.name, 255);
    const userEmail = normalizeEmail(meJson.data.email || '');
    const expiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);

    await pool.query(
      `INSERT INTO pipedrive_oauth_user
        (company_id, user_id, user_name, user_email, access_token, refresh_token, api_domain, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (company_id, user_id) DO UPDATE SET
         user_name = EXCLUDED.user_name,
         user_email = EXCLUDED.user_email,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         api_domain = EXCLUDED.api_domain,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [companyId, userId, userName, userEmail, tokens.access_token, tokens.refresh_token, tokens.api_domain, expiresAt]
    );

    const authorizationText = `OAuth individual autorizado para <strong>${escapeHtmlServer(userName || `Usuário #${userId}`)}</strong> (usuário #${userId}). As chamadas feitas por este usuário usarão o token dele próprio.`;

    res.type('html').send(`<!doctype html>
      <html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Aplicativo instalado</title><style>body{font-family:Arial,sans-serif;background:#f7f7f7;margin:0;padding:40px}.box{max-width:680px;margin:auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 3px 16px #0001}.ok{font-size:42px}h1{margin:8px 0 12px}.note{padding:12px;border-radius:8px;background:#eef6ff;margin:16px 0}</style></head>
      <body><div class="box"><div class="ok">✅</div><h1>Aplicativo autorizado</h1><div class="note">${authorizationText}</div><p>O proprietário e o autor das chamadas da API passam a ser o próprio usuário que autorizou a aplicação. Cada vendedor deve autorizar com o próprio login.</p><p>Volte ao Pipedrive e teste <strong>Cadastrar cliente</strong>.</p></div></body></html>`);
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

    // Se o CNPJ já foi criado/confirmado pelo app, o vínculo com a Organização é imutável.
    const registryBinding = await getCnpjBindingByCnpj(companyId, cnpj);
    if (registryBinding?.organization_id) {
      const cnpjFieldKey = await getCnpjFieldKey(companyId);
      const boundOrg = await getOrganization(companyId, registryBinding.organization_id, cnpjFieldKey);
      const currentCnpj = normalizeCnpj(boundOrg?.custom_fields?.[cnpjFieldKey] || '');
      if (currentCnpj !== cnpj) {
        throw cnpjLockError(
          'CNPJ_CHANGED_OUTSIDE_APP',
          `O CNPJ ${formatCnpj(cnpj)} está vinculado à Organização #${registryBinding.organization_id}, mas o campo foi alterado no Pipedrive para ${currentCnpj ? formatCnpj(currentCnpj) : 'vazio'}. Restaure o CNPJ original antes de continuar.`
        );
      }
      return res.json({
        ok: true, valid: true, exists: true, cnpj, formattedCnpj: formatCnpj(cnpj),
        organizations: [{ id: Number(boundOrg.id), name: boundOrg.name, address: boundOrg?.address?.value || boundOrg?.address || null }],
        registry: null
      });
    }

    // Primeiro consulta o próprio Pipedrive. Se já existir, não desperdiça uma chamada externa.
    const pipeResult = await searchOrganizationsByCnpj(companyId, cnpj);
    if (pipeResult.organizations.length) {
      for (const org of pipeResult.organizations) {
        const previousBinding = await getCnpjBindingByOrganization(companyId, org.id);
        if (previousBinding && normalizeCnpj(previousBinding.cnpj) !== cnpj) {
          throw cnpjLockError(
            'CNPJ_CHANGED_OUTSIDE_APP',
            `A Organização #${org.id} já foi vinculada ao CNPJ ${formatCnpj(previousBinding.cnpj)} e agora está com ${formatCnpj(cnpj)}. O CNPJ não pode ser substituído.`
          );
        }
      }

      // Quando há uma única Organização, já consolida o vínculo imutável.
      // Em duplicidades históricas, aguarda o usuário escolher qual registro será o canônico.
      if (pipeResult.organizations.length === 1) {
        await bindCnpjToOrganization(companyId, cnpj, pipeResult.organizations[0].id);
      }

      return res.json({
        ok: true,
        valid: true,
        exists: true,
        cnpj,
        formattedCnpj: formatCnpj(cnpj),
        organizations: pipeResult.organizations.map((org) => ({
          id: org.id,
          name: org.name,
          address: org.address || null
        })),
        registry: null
      });
    }

    // Só consulta a BrasilAPI quando o CNPJ ainda não existe no Pipedrive.
    const registry = await lookupBrasilApiCnpj(cnpj);

    return res.json({
      ok: true,
      valid: true,
      exists: false,
      cnpj,
      formattedCnpj: formatCnpj(cnpj),
      organizations: [],
      registry
    });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/link-existing', async (req, res) => {
  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);

    const companyId = String(req.body.companyId || '');
    const dealId = String(req.body.dealId || '');
    const organizationId = Number(req.body.organizationId);

    if (!companyId || !dealId || !organizationId) {
      return res.status(400).json({ ok: false, error: 'companyId/dealId/organizationId não informados.' });
    }
    validateCompanyAgainstToken(payload, companyId);

    await linkContactsToDeal(companyId, dealId, organizationId);
    const org = await getOrganization(companyId, organizationId, await getCnpjFieldKey(companyId));

    return res.json({
      ok: true,
      action: 'linked_existing',
      organization: { id: organizationId, name: org?.name || `Organização ${organizationId}` },
      dealId: Number(dealId)
    });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/create-company-contact-link', async (req, res) => {
  let reservationMade = false;
  let companyId;
  let cnpj;

  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);
    const ownerId = resolveLoggedUserId(payload, req.body.userId);

    companyId = String(req.body.companyId || '');
    const dealId = String(req.body.dealId || '');
    cnpj = normalizeCnpj(req.body.cnpj);

    if (!companyId || !dealId) {
      return res.status(400).json({ ok: false, error: 'companyId/dealId não informados.' });
    }
    validateCompanyAgainstToken(payload, companyId);

    if (!isValidCnpj(cnpj)) return res.status(422).json({ ok: false, error: 'CNPJ inválido.' });

    const validationError = validateNewCompanyPayload(req.body);
    if (validationError) return res.status(422).json({ ok: false, error: validationError });

    // Revalida no último instante para evitar duas telas criando o mesmo CNPJ.
    const existingResult = await searchOrganizationsByCnpj(companyId, cnpj);
    if (existingResult.organizations.length) {
      return res.status(409).json({
        ok: false,
        code: 'CNPJ_ALREADY_EXISTS',
        error: 'Este CNPJ já existe no Pipedrive. Revalide e selecione a organização existente.',
        organizations: existingResult.organizations.map((org) => ({ id: org.id, name: org.name }))
      });
    }

    // Se a BrasilAPI localizar o CNPJ e a situação não for ATIVA, bloqueia a criação.
    // Se a API estiver indisponível ou ainda não localizar o CNPJ, o preenchimento manual continua possível.
    const registryValidation = await lookupBrasilApiCnpj(cnpj, { withEmailFallback: false });
    if (registryValidation.found && !registryValidation.active) {
      return res.status(422).json({
        ok: false,
        code: 'CNPJ_NOT_ACTIVE',
        error: `CNPJ com situação cadastral ${registryValidation.status || 'NÃO ATIVA'}. O cadastro foi bloqueado.`,
        registry: registryValidation
      });
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
        const err = new Error('Este CNPJ já foi criado por outro processo. Revalide o CNPJ para vinculá-lo.');
        err.status = 409;
        throw err;
      }

      const err = new Error('Este CNPJ está sendo cadastrado por outro processo. Aguarde alguns segundos e tente novamente.');
      err.status = 409;
      throw err;
    }
    reservationMade = true;

    const cnpjFieldKey = await getCnpjFieldKey(companyId);
    const createResult = await createOrganization(
      companyId,
      req.body,
      cnpj,
      cnpjFieldKey,
      registryValidation.found ? registryValidation.data : null,
      ownerId
    );
    const organization = createResult.organization;
    await writeAudit({ companyId, actorUserId: ownerId, action: 'CREATE_ORGANIZATION', entityType: 'organization', entityId: organization.id, cnpj, details: { ownerId, legacyFlow: true } });

    // Registra o ID imediatamente para não perder a referência se a criação da Pessoa falhar.
    await pool.query(
      `UPDATE cnpj_registry
          SET organization_id=$3, status='organization_created', updated_at=NOW()
        WHERE company_id=$1 AND cnpj=$2`,
      [companyId, cnpj, organization.id]
    );

    const person = await createPerson(companyId, organization.id, req.body, ownerId);
    await writeAudit({ companyId, actorUserId: ownerId, action: 'CREATE_PERSON', entityType: 'person', entityId: person.id, cnpj, details: { organizationId: organization.id, ownerId, legacyFlow: true } });
    await linkContactsToDeal(companyId, dealId, organization.id, person.id);

    await pool.query(
      `UPDATE cnpj_registry
          SET status='ready', updated_at=NOW()
        WHERE company_id=$1 AND cnpj=$2`,
      [companyId, cnpj]
    );

    return res.json({
      ok: true,
      action: 'created_company_contact_and_linked',
      organization: { id: Number(organization.id), name: organization.name },
      person: { id: Number(person.id), name: person.name },
      dealId: Number(dealId),
      warnings: createResult.warnings || []
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


// =========================
// v5 - Fluxo antes do Deal
// =========================

app.get('/floating', (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) {
      return res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>body{font-family:Arial;padding:28px;color:#333}</style></head><body><h2>Cadastrar cliente</h2><p>Esta página deve ser aberta pela janela flutuante do aplicativo dentro do Pipedrive.</p></body></html>`);
    }
    verifyExtensionToken(token);
    res.sendFile(path.join(__dirname, 'public', 'floating.html'));
  } catch (error) {
    res.status(401).type('html').send(`<h3>Não foi possível validar a janela.</h3><p>${String(error.message || error)}</p>`);
  }
});

function personPhones(person) {
  const list = person?.phones || person?.phone || [];
  return Array.isArray(list) ? list.map((x) => x?.value || x).filter(Boolean) : [];
}

function personEmails(person) {
  const list = person?.emails || person?.email || [];
  return Array.isArray(list) ? list.map((x) => x?.value || x).filter(Boolean) : [];
}

async function getPersonsByOrganization(companyId, organizationId) {
  const params = new URLSearchParams({
    org_id: String(organizationId),
    limit: '100'
  });
  const json = await pipedriveRequest(companyId, `/api/v2/persons?${params.toString()}`);
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((person) => ({
    id: Number(person.id),
    name: person.name || `Pessoa ${person.id}`,
    phones: personPhones(person),
    emails: personEmails(person)
  }));
}

app.post('/api/persons-by-organization', async (req, res) => {
  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);
    const companyId = String(req.body.companyId || '');
    const organizationId = Number(req.body.organizationId);

    if (!companyId || !organizationId) {
      return res.status(400).json({ ok: false, error: 'companyId/organizationId não informados.' });
    }
    validateCompanyAgainstToken(payload, companyId);

    const organization = await getOrganization(companyId, organizationId, await getCnpjFieldKey(companyId));
    const persons = await getPersonsByOrganization(companyId, organizationId);

    res.json({
      ok: true,
      organization: { id: organizationId, name: organization?.name || `Organização ${organizationId}` },
      persons
    });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/create-contact-existing', async (req, res) => {
  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);
    const ownerId = resolveLoggedUserId(payload, req.body.userId);
    const companyId = String(req.body.companyId || '');
    const organizationId = Number(req.body.organizationId);
    const cnpj = normalizeCnpj(req.body.cnpj);

    if (!companyId || !organizationId || !isValidCnpj(cnpj)) {
      return res.status(400).json({ ok: false, error: 'companyId/organizationId/CNPJ não informados ou inválidos.' });
    }
    validateCompanyAgainstToken(payload, companyId);
    await verifyOrganizationCnpj(companyId, organizationId, cnpj);

    const validationError = validateNewCompanyPayload({
      legalName: 'organização existente',
      contactName: req.body.contactName,
      phone: req.body.phone,
      email: req.body.email
    });
    if (validationError) return res.status(422).json({ ok: false, error: validationError });

    const organization = await getOrganization(companyId, organizationId, await getCnpjFieldKey(companyId));
    const person = await createPerson(companyId, organizationId, req.body, ownerId);
    await writeAudit({ companyId, actorUserId: ownerId, action: 'CREATE_PERSON', entityType: 'person', entityId: person.id, cnpj, details: { organizationId } });

    res.json({
      ok: true,
      action: 'created_contact_for_existing_organization',
      organization: { id: organizationId, name: organization?.name || `Organização ${organizationId}` },
      person: { id: Number(person.id), name: person.name }
    });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/create-client', async (req, res) => {
  let reservationMade = false;
  let companyId;
  let cnpj;

  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);
    const ownerId = resolveLoggedUserId(payload, req.body.userId);

    companyId = String(req.body.companyId || '');
    cnpj = normalizeCnpj(req.body.cnpj);
    if (!companyId) return res.status(400).json({ ok: false, error: 'companyId não informado.' });
    validateCompanyAgainstToken(payload, companyId);

    if (!isValidCnpj(cnpj)) return res.status(422).json({ ok: false, error: 'CNPJ inválido.' });

    const validationError = validateNewCompanyPayload(req.body);
    if (validationError) return res.status(422).json({ ok: false, error: validationError });

    const existingResult = await searchOrganizationsByCnpj(companyId, cnpj);
    if (existingResult.organizations.length) {
      return res.status(409).json({
        ok: false,
        code: 'CNPJ_ALREADY_EXISTS',
        error: 'Este CNPJ já existe no Pipedrive. Revalide e selecione a organização existente.',
        organizations: existingResult.organizations.map((org) => ({ id: org.id, name: org.name }))
      });
    }

    const registryValidation = await lookupBrasilApiCnpj(cnpj, { withEmailFallback: false });
    if (registryValidation.found && !registryValidation.active) {
      return res.status(422).json({
        ok: false,
        code: 'CNPJ_NOT_ACTIVE',
        error: `CNPJ com situação cadastral ${registryValidation.status || 'NÃO ATIVA'}. O cadastro foi bloqueado.`,
        registry: registryValidation
      });
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
        const err = new Error('Este CNPJ já foi criado por outro processo. Revalide o CNPJ para selecionar a empresa existente.');
        err.status = 409;
        throw err;
      }
      const err = new Error('Este CNPJ está sendo cadastrado por outro processo. Aguarde alguns segundos e tente novamente.');
      err.status = 409;
      throw err;
    }
    reservationMade = true;

    const cnpjFieldKey = await getCnpjFieldKey(companyId);
    const createResult = await createOrganization(
      companyId,
      req.body,
      cnpj,
      cnpjFieldKey,
      registryValidation.found ? registryValidation.data : null,
      ownerId
    );
    const organization = createResult.organization;
    await writeAudit({ companyId, actorUserId: ownerId, action: 'CREATE_ORGANIZATION', entityType: 'organization', entityId: organization.id, cnpj, details: { ownerId } });

    await pool.query(
      `UPDATE cnpj_registry
          SET organization_id=$3, status='organization_created', updated_at=NOW()
        WHERE company_id=$1 AND cnpj=$2`,
      [companyId, cnpj, organization.id]
    );

    const person = await createPerson(companyId, organization.id, req.body, ownerId);
    await writeAudit({ companyId, actorUserId: ownerId, action: 'CREATE_PERSON', entityType: 'person', entityId: person.id, cnpj, details: { organizationId: organization.id, ownerId } });

    await pool.query(
      `UPDATE cnpj_registry SET status='ready', updated_at=NOW()
        WHERE company_id=$1 AND cnpj=$2`,
      [companyId, cnpj]
    );

    res.json({
      ok: true,
      action: 'created_client_before_deal',
      organization: { id: Number(organization.id), name: organization.name },
      person: { id: Number(person.id), name: person.name },
      warnings: createResult.warnings || []
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


async function verifyDealCnpjBinding(companyId, organizationId, rawCnpj) {
  const cnpj = normalizeCnpj(rawCnpj);
  const orgId = Number(organizationId);
  if (!isValidCnpj(cnpj) || !orgId) {
    throw cnpjLockError('CNPJ_REQUIRED_FOR_DEAL', 'Revalide o CNPJ antes de criar o negócio.');
  }

  // Para criar o negócio não precisamos reler o campo CNPJ do Pipedrive quando
  // o vínculo já foi estabelecido pelo próprio backend. Isso evita bloquear a
  // criação do Deal por uma leitura adicional de custom_fields logo após criar
  // Organização/Pessoa. A alteração de CNPJ continua protegida no cadastro,
  // atualização cadastral e nas próximas consultas do CNPJ.
  const boundOrg = await getCnpjBindingByOrganization(companyId, orgId);
  if (boundOrg) {
    const bound = normalizeCnpj(boundOrg.cnpj);
    if (bound !== cnpj) {
      throw cnpjLockError(
        'ORG_CNPJ_LOCKED',
        `A Organização #${orgId} está vinculada ao CNPJ ${formatCnpj(bound)} e não ao CNPJ ${formatCnpj(cnpj)}.`
      );
    }
    return;
  }

  const boundCnpj = await getCnpjBindingByCnpj(companyId, cnpj);
  if (boundCnpj?.organization_id) {
    if (Number(boundCnpj.organization_id) !== orgId) {
      throw cnpjLockError(
        'CNPJ_BOUND_TO_OTHER_ORG',
        `O CNPJ ${formatCnpj(cnpj)} já está vinculado à Organização #${boundCnpj.organization_id}.`
      );
    }
    return;
  }

  // Organização antiga ainda não registrada no nosso controle: valida uma vez
  // diretamente no Pipedrive e consolida o vínculo imutável no Postgres.
  await verifyOrganizationCnpj(companyId, orgId, cnpj);
}

app.post('/api/create-deal', async (req, res) => {
  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);
    const ownerId = resolveLoggedUserId(payload, req.body.userId);
    const companyId = String(req.body.companyId || '');
    const organizationId = Number(req.body.organizationId);
    const personId = Number(req.body.personId);
    const cnpj = normalizeCnpj(req.body.cnpj);

    if (!companyId || !organizationId || !personId || !isValidCnpj(cnpj)) {
      return res.status(400).json({ ok: false, error: 'companyId/organizationId/personId/CNPJ não informados ou inválidos.' });
    }
    validateCompanyAgainstToken(payload, companyId);
    await verifyDealCnpjBinding(companyId, organizationId, cnpj);

    const result = await createDealIdempotent(companyId, organizationId, personId, req.body, ownerId);
    const warnings = [];
    let auditNote = null;
    if (!result.reused) {
      try {
        auditNote = await createVisibleAuditNote(companyId, ownerId, result.deal.id, cnpj, organizationId, personId);
      } catch (noteError) {
        console.error('Falha ao criar anotação de auditoria:', noteError);
        warnings.push('Negócio criado, mas não foi possível criar a anotação visível de auditoria.');
      }
      await writeAudit({ companyId, actorUserId: ownerId, action: 'CREATE_DEAL', entityType: 'deal', entityId: result.deal.id, cnpj, noteId: auditNote?.id || null, details: { organizationId, personId, ownerId, requestId: clean(req.body.requestId, 80) } });
    }
    res.json({
      ok: true,
      deal: { id: Number(result.deal.id), title: result.deal.title },
      reused: result.reused,
      auditNote: auditNote ? { id: Number(auditNote.id) } : null,
      warnings
    });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/sync-existing-organization', async (req, res) => {
  try {
    assertConfig();
    const token = req.get('x-pipedrive-token') || req.body?.token;
    const payload = verifyExtensionToken(token);
    const companyId = String(req.body.companyId || '');
    const organizationId = Number(req.body.organizationId);
    const cnpj = normalizeCnpj(req.body.cnpj);

    if (!companyId || !organizationId || !isValidCnpj(cnpj)) {
      return res.status(400).json({ ok: false, error: 'companyId/organizationId/CNPJ inválidos.' });
    }
    validateCompanyAgainstToken(payload, companyId);

    // CNPJ é imutável: confirma que a Organização selecionada ainda possui exatamente o CNPJ consultado.
    // A atualização cadastral nunca envia o campo CNPJ no PATCH.
    await verifyOrganizationCnpj(companyId, organizationId, cnpj);

    const registry = await lookupBrasilApiCnpj(cnpj);
    if (!registry.found) {
      return res.status(422).json({ ok: false, error: registry.warning || 'Dados cadastrais não localizados.' });
    }

    const registryFields = await buildRegistryCustomFields(companyId, registry.data);
    const customFields = { ...registryFields.customFields };

    const d = registry.data;
    const body = { custom_fields: customFields };
    if (d.addressLine || d.postalCode || d.city || d.state) {
      body.address = {
        value: d.addressLine || [d.city, d.state].filter(Boolean).join(' - '),
        country: 'Brasil',
        admin_area_level_1: d.state || undefined,
        locality: d.city || undefined,
        postal_code: d.postalCode || undefined
      };
    }

    const updated = await pipedriveRequest(
      companyId,
      `/api/v2/organizations/${encodeURIComponent(organizationId)}`,
      { method: 'PATCH', body: JSON.stringify(body) }
    );

    const actorUserId = resolveLoggedUserId(payload, req.body.userId);
    await writeAudit({ companyId, actorUserId, action: 'SYNC_ORGANIZATION', entityType: 'organization', entityId: organizationId, cnpj, details: { fieldsUpdated: Object.keys(customFields) } });

    res.json({
      ok: true,
      organization: { id: Number(updated.data.id), name: updated.data.name },
      registry,
      warnings: registryFields.warnings || []
    });
  } catch (error) {
    apiError(res, error);
  }
});


initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Pipedrive CNPJ MVP v6.4.1 ouvindo na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Falha ao inicializar banco:', error);
    process.exit(1);
  });
