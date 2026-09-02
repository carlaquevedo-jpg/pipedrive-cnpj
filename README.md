# Pipedrive CNPJ MVP v6.2.0

Esta versão parte da v6.0.0 e acrescenta os ajustes de proprietário e e-mail cadastral da Organização.


## Ajuste da v6.2.0

- Mantém a BrasilAPI como fonte principal.
- Se a BrasilAPI devolver o campo `email` vazio/nulo, consulta a API pública do CNPJ.ws somente para recuperar o endereço eletrônico.
- O fallback só é chamado quando necessário e não bloqueia o cadastro se estiver indisponível.
- Caches de CNPJ das últimas 24h que ficaram sem e-mail também são enriquecidos automaticamente na próxima consulta.
- A origem do e-mail fica disponível em `registry.data.emailSource` (`BrasilAPI` ou `CNPJ.ws`).

## Ajustes da v6.1.0

- O **Proprietário** dos novos registros passa a ser o **usuário que está logado e abriu a extensão do Pipedrive**, usando o `userId` enviado pelo Custom Floating Window e o JWT assinado da extensão.
- Ao criar uma empresa nova, o mesmo usuário é enviado como `owner_id` da **Organização**, da **Pessoa** e do **Negócio**.
- Quando a BrasilAPI retorna o campo `email` (endereço eletrônico), ele passa a preencher **E-mail da organização** na tela.
- O e-mail cadastral da empresa não é mais colocado automaticamente no e-mail do contato principal; o e-mail da Pessoa deve ser informado/confirmado separadamente.
- Na Organização, o e-mail é salvo em um campo personalizado chamado **E-mail**, **Email** ou **Endereço Eletrônico**.
- A ação **Atualizar dados cadastrais** também atualiza esse e-mail em Organizações já existentes.

> Observação: a API v2 de Organizações do Pipedrive não possui um campo nativo de e-mail. Crie um campo personalizado de Organização do tipo texto chamado `E-mail` ou `Endereço Eletrônico`. O app localiza esse campo automaticamente.

> Para atribuir `owner_id` a outro usuário, o usuário técnico/OAuth usado pelo backend precisa ter permissão para alterar o proprietário dos registros.

## O que mudou

- A janela flutuante sempre abre limpa ao ser exibida novamente.
- A data da situação cadastral é mostrada ao usuário em `DD/MM/AAAA`.
- O valor salvo no campo **Data Situação Cadastral** continua em `AAAA-MM-DD`, que é o formato exigido pelo Pipedrive.
- Os dados da BrasilAPI são armazenados em cache no Postgres por 24 horas para que a criação da Organização use exatamente os dados que acabaram de ser consultados, evitando uma segunda consulta externa e perda dos dados por rate limit/indisponibilidade.
- O mapeamento de campos personalizados aceita `field_code`, `key` ou `code` retornados pela API de campos do Pipedrive.
- Foi incluída a ação **Atualizar dados cadastrais** para Organização já existente. Isso é útil para corrigir cadastros criados durante os testes anteriores.
- O modal nativo **Adicionar negócio** não é mais usado. O SDK do Pipedrive só permite `CLOSE_MODAL` para modais personalizados, então não existe uma forma segura de fechar programaticamente o modal nativo após o primeiro Salvar.
- O negócio agora é criado diretamente via `POST /api/v2/deals`.
- A criação do negócio possui uma chave idempotente no Postgres. Repetir a mesma requisição não cria outro Deal.
- Para empresa nova, o botão **Criar cliente e negócio** cria Organização, Pessoa e Deal em sequência.
- Para empresa já existente, selecione/crie o contato e use **Criar negócio**.
- Após criar o Deal, a janela flutuante é ocultada e o usuário é direcionado ao negócio criado.

## Campos personalizados da Organização esperados

- CNPJ
- Nome Fantasia
- Situação Cadastral
- Data Situação Cadastral
- CNAE Principal
- Descrição CNAE Principal
- Natureza Jurídica
- Quadro Societário (QSA)
- E-mail (ou Endereço Eletrônico)

`Situação Cadastral` deve ser uma opção única contendo, conforme aplicável:

- ATIVA
- BAIXADA
- INAPTA
- SUSPENSA
- NULA

## Atualização no Render

Substitua no repositório principalmente:

- `server.js`
- `package.json`
- `public/floating.html`
- `README.md`

Depois faça `Manual Deploy -> Deploy latest commit`.

Confirme:

```text
https://pipedrive-cnpj.onrender.com/health
```

O retorno deve conter:

```json
"version": "6.2.0"
```

Não é necessário alterar a URL da janela flutuante no Developer Hub:

```text
https://pipedrive-cnpj.onrender.com/floating
```
