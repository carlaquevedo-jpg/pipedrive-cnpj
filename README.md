# Pipedrive CNPJ MVP v6.0.0

Esta versão corrige os pontos encontrados nos testes da janela flutuante.

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
"version": "6.0.0"
```

Não é necessário alterar a URL da janela flutuante no Developer Hub:

```text
https://pipedrive-cnpj.onrender.com/floating
```
