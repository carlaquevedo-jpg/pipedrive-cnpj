# Pipedrive CNPJ MVP v6.3.1

## v6.3.1 — correção de criação do negócio

- Corrige a regressão em que a Organização e a Pessoa eram criadas, mas o Deal podia parar na etapa “Cliente pronto”.
- A criação do Deal usa o vínculo CNPJ ↔ Organização já consolidado pelo backend e não relê desnecessariamente o custom field imediatamente após o cadastro.
- Mantém a proteção de CNPJ imutável nas consultas, criação e atualização cadastral.
- Se o Deal falhar, a tela não duplica mais os dois formulários: mantém somente “Cliente pronto” e mostra o erro real para permitir nova tentativa.


Esta versão parte da v6.2.1 e acrescenta governança de CNPJ e OAuth técnico.

## v6.3.1 — principais mudanças

### CNPJ imutável

- O CNPJ é gravado somente na criação da Organização.
- **Atualizar dados cadastrais** não envia mais o campo CNPJ no `PATCH`.
- O Postgres mantém o vínculo `company_id + CNPJ -> organization_id`.
- Se uma Organização já vinculada aparecer com outro CNPJ, o app bloqueia a operação e informa que o CNPJ foi alterado fora do fluxo validado.
- Antes de criar contato ou negócio em uma Organização existente, o backend confirma que o CNPJ atual ainda é exatamente o CNPJ consultado.
- Na janela flutuante, depois de uma consulta válida, o campo CNPJ fica somente leitura. O botão passa a ser **Nova consulta**.

> Importante: o backend impede que o nosso aplicativo aceite/troque um CNPJ já vinculado, mas não consegue impedir sozinho uma edição manual feita diretamente na tela do Pipedrive. Configure também o campo personalizado **CNPJ** como somente leitura para os conjuntos de permissão dos vendedores.

### OAuth técnico fixo

- O token usado nas chamadas da API fica fixado no usuário técnico **Sistema Interno**.
- O `owner_id` continua sendo o usuário que abriu a extensão, portanto o proprietário da Organização/Pessoa/Negócio permanece o vendedor logado.
- Autorizações feitas depois por Carla, Milton ou outros usuários não substituem mais o OAuth técnico.
- O histórico nativo de chamadas da API passa a ficar associado ao usuário técnico em vez de ao último usuário que autorizou o app.
- O `/health` informa `technicalOauthReady` e `technicalUserName`.

### Auditoria própria

A versão cria a tabela `app_audit_log`, registrando:

- usuário real que solicitou a ação (`actor_user_id`);
- usuário técnico usado pela API (`technical_user_id`);
- ação realizada;
- tipo e ID da entidade;
- CNPJ;
- detalhes básicos da operação;
- data/hora.

As ações auditadas incluem criação de Organização, Pessoa e Negócio e atualização cadastral.

## Passo obrigatório após o primeiro deploy da v6.3

As versões anteriores guardavam apenas um OAuth por empresa e esse token podia ter sido sobrescrito pelo último usuário que autorizou o app. Ao iniciar a v6.3, o registro antigo fica **não bloqueado**.

Faça nesta ordem:

1. Suba a v6.3 e faça o deploy.
2. Confirme `/health` com `"version":"6.3.0"` e `"technicalOauthReady":false`.
3. **Antes de outro usuário autorizar/testar**, entre na sandbox como **Sistema Interno**.
4. Autorize/instale o aplicativo novamente uma vez.
5. Consulte `/health` de novo. Deve aparecer:

```json
{
  "technicalOauthReady": true,
  "technicalUserName": "Sistema Interno",
  "version": "6.3.0"
}
```

Depois disso, autorizações de outros usuários não substituem mais o token técnico.

## Bloquear edição manual do CNPJ no Pipedrive

Além da proteção no código:

1. Vá em **Campos de dados -> Organização -> CNPJ -> Editar**.
2. Em especificações/permissões de usuário, retire a edição dos conjuntos usados pelos vendedores.
3. Mantenha a permissão necessária apenas para administradores/integração conforme sua política.

O campo fica visível, mas não editável para os usuários restritos.

## Recursos preservados da v6.2.1

- Proprietário = usuário logado.
- E-mail cadastral da Organização em campo personalizado `E-mail`.
- BrasilAPI como fonte principal e CNPJ.ws como fallback somente para endereço eletrônico.
- Cache de CNPJ no Postgres.
- Criação direta do Deal sem modal nativo.
- Idempotência para não duplicar negócio.
- Reset da janela flutuante ao reabrir.
- Atualização cadastral de Organização existente.

## Deploy

Substitua os arquivos no repositório e faça `Manual Deploy -> Deploy latest commit`. Não é necessário alterar a URL da janela flutuante no Developer Hub.
