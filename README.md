# Pipedrive CNPJ MVP

MVP para abrir um Custom Modal no detalhe de um Deal, validar CNPJ, procurar uma Organização pelo campo personalizado CNPJ, criar a Organização caso não exista e vincular a Organização ao Deal.

## Importante: CNPJ alfanumérico

O validador aceita o formato legado numérico e o novo CNPJ alfanumérico (12 posições alfanuméricas + 2 DVs numéricos).

## Rotas

- `/` status simples
- `/health` diagnóstico
- `/modal` iframe do Custom Modal
- `/oauth/callback` callback OAuth do Pipedrive
- `POST /api/check-cnpj` valida e procura CNPJ
- `POST /api/create-link` cria/reutiliza organização e vincula ao Deal

## Render

### 1. Crie um Render Postgres (Free, apenas para MVP)

Copie a **Internal Database URL**.

### 2. Crie um Web Service

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Instance: Free (para teste)

### 3. Variáveis de ambiente

- `PIPEDRIVE_CLIENT_ID`
- `PIPEDRIVE_CLIENT_SECRET`
- `PIPEDRIVE_CALLBACK_URL` = `https://SEU-SERVICO.onrender.com/oauth/callback`
- `DATABASE_URL` = Internal Database URL do Render Postgres
- `PIPEDRIVE_JWT_SECRET` (opcional; se a chave JWT do modal ficou em branco, deixe vazio e o app usa o client secret)
- `PIPEDRIVE_CNPJ_FIELD_KEY` (opcional; o MVP tenta localizar automaticamente um campo de Organização chamado CNPJ)

### 4. Pipedrive Developer Hub

Callback OAuth:

`https://SEU-SERVICO.onrender.com/oauth/callback`

Custom Modal > Iframe URL:

`https://SEU-SERVICO.onrender.com/modal`

Entry point:

`Deal details`

### 5. Instale/teste o app novamente

Depois de alterar a callback, execute Install & Test novamente na sandbox.
