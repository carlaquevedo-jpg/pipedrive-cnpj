# Pipedrive CNPJ MVP v2

MVP para uso em **Custom Modal > Deal details** no Pipedrive.

## Fluxo

1. Usuário abre um Deal e escolhe **Cadastrar / Vincular empresa**.
2. Informa o CNPJ.
3. O backend valida o DV e pesquisa Organizações no Pipedrive.
4. Se o CNPJ já existir, a Organização existente é vinculada ao Deal.
5. Se não existir, o modal solicita:
   - Razão Social
   - Nome Fantasia (opcional)
   - CEP, Cidade, UF e Endereço (opcionais)
   - Nome do contato
   - Telefone
   - E-mail
6. O backend cria a Organização, cria a Pessoa vinculada à Organização e atualiza o Deal com `org_id` e `person_id`.

## Correção incluída para `Scope and URL mismatch`

A busca por CNPJ agora usa:

`GET /api/v2/organizations/search?fields=custom_fields&exact_match=true`

em vez de `/api/v2/itemSearch/field`.

Isso permite usar o scope `contacts:full` já concedido à app, sem depender de `search:read`.

## Scopes necessários no Pipedrive

- Deals: Full access
- Contacts: Full access

`Contact Fields: Full access` não é necessário para este MVP, porque o app apenas lê as definições dos campos existentes.

## Campos

### Organização

- `name` = Razão Social
- campo personalizado `CNPJ` = CNPJ normalizado, sem máscara
- `address` = Endereço/CEP/Cidade/UF quando informados
- `Nome Fantasia` = preenchido somente se existir um campo de Organização com esse nome

### Pessoa

- `name` = Nome do contato
- `phones` = Telefone principal
- `emails` = E-mail principal
- `org_id` = Organização criada

### Deal

- `org_id` = Organização
- `person_id` = Pessoa criada

## Variáveis de ambiente

- `PIPEDRIVE_CLIENT_ID`
- `PIPEDRIVE_CLIENT_SECRET`
- `PIPEDRIVE_CALLBACK_URL`
- `DATABASE_URL`
- `PIPEDRIVE_JWT_SECRET` (opcional)
- `PIPEDRIVE_CNPJ_FIELD_KEY` (opcional)
- `PIPEDRIVE_TRADE_NAME_FIELD_KEY` (opcional)

## Deploy no Render

Depois de atualizar os arquivos no GitHub, use:

**Manual Deploy > Deploy latest commit**

Confira:

`https://pipedrive-cnpj.onrender.com/health`

A resposta deve indicar `version: "2.0.0"`.

A URL do Custom Modal continua:

`https://pipedrive-cnpj.onrender.com/modal`
