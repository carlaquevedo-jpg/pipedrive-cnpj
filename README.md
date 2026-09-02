# Pipedrive CNPJ MVP v6.4.0

## v6.4.0 — OAuth individual por vendedor + auditoria visível

Esta versão parte da v6.3.1 e muda a autenticação das chamadas ao Pipedrive.

### OAuth individual

- Cada vendedor precisa instalar/autorizar a aplicação com o próprio login.
- O token é salvo por `company_id + user_id` em `pipedrive_oauth_user`.
- Carla usa o token da Carla; Milton usa o token do Milton.
- Organização, Pessoa, Deal, consultas e atualizações são executadas com o OAuth do usuário que abriu a extensão.
- Assim, o histórico nativo do Pipedrive deve aparecer como `Milton (API)`, `Carla (API)`, etc.
- Se o usuário ainda não autorizou a aplicação, a API retorna `USER_OAUTH_REQUIRED` com mensagem clara.
- O token de um usuário nunca sobrescreve o token de outro.

> Importante: a API respeita as permissões do usuário que autorizou. Enquanto validamos esta arquitetura, não retire dos vendedores as permissões necessárias para criar Organização/Pessoa/Negócio via API.

### Auditoria visível no negócio

Ao criar um Deal novo, a integração também cria uma anotação fixada no negócio com:

- usuário que solicitou/executou;
- CNPJ;
- ID da Organização;
- ID do Contato;
- ID do Negócio;
- data/hora.

A anotação é criada pelo mesmo OAuth individual. O log técnico no Postgres continua em `app_audit_log` e agora registra também o usuário executor e, quando possível, o ID da anotação.

### CNPJ imutável preservado

Mantém as proteções da v6.3.1:

- CNPJ bloqueado na interface depois da consulta;
- atualização cadastral nunca altera o CNPJ;
- vínculo `company_id + CNPJ -> organization_id` no Postgres;
- bloqueio de inconsistência se uma Organização vinculada aparecer com CNPJ diferente;
- proteção contra duplicidade e criação simultânea.

## Primeiro deploy da v6.4

Os tokens técnicos/antigos não são usados pela v6.4. Cada usuário que for testar deve autorizar novamente a aplicação.

Na sandbox em DRAFT:

1. Entrar no Pipedrive com o usuário que vai testar.
2. Abrir o Developer Hub.
3. `Validação CNPJ -> Install & test`.
4. Autorizar os escopos.
5. Voltar ao Pipedrive e abrir `Cadastrar cliente`.

Quando a Private App estiver LIVE, use o link de instalação privado do Developer Hub. O mesmo link pode ser enviado aos vendedores, mas cada um precisa abri-lo logado na própria conta e autorizar individualmente.

## Health

`GET /health`

Exemplo:

```json
{
  "ok": true,
  "database": true,
  "pipedriveConfigured": true,
  "oauthMode": "individual-user",
  "authorizedUsers": 2,
  "version": "6.4.0"
}
```

## Teste recomendado

1. Autorize primeiro com Carla Teste e faça um cadastro novo.
2. Confirme proprietário e histórico como `Carla Teste (API)`.
3. Autorize com Milton e faça outro cadastro novo.
4. Confirme proprietário e histórico como `Milton (API)`.
5. Abra o Deal e confirme a anotação `Cadastro realizado via Validação CNPJ`.
6. Confirme que uma nova consulta do mesmo CNPJ reutiliza a Organização existente.

## Variáveis de ambiente

Mantém as mesmas variáveis das versões anteriores:

- `DATABASE_URL`
- `PIPEDRIVE_CLIENT_ID`
- `PIPEDRIVE_CLIENT_SECRET`
- `PIPEDRIVE_CALLBACK_URL`
- `PIPEDRIVE_JWT_SECRET` (opcional; fallback para client secret)
- chaves opcionais dos campos personalizados, se desejado.

Não é necessário configurar usuário técnico na v6.4.
