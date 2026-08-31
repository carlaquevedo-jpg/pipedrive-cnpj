# Pipedrive CNPJ MVP v4

Esta versão mantém o fluxo da v3 e passa a **gravar automaticamente os dados cadastrais da BrasilAPI nos campos personalizados da Organização**.

## Campos personalizados esperados na Organização

Crie com estes nomes:

- `CNPJ` — Texto
- `Nome Fantasia` — Texto
- `Situação Cadastral` — Opção única
- `Data Situação Cadastral` — Data
- `CNAE Principal` — Texto ou Texto longo
- `Descrição CNAE Principal` — Texto longo
- `Natureza Jurídica` — Texto longo
- `Quadro Societário (QSA)` — Texto longo

### Opções do campo Situação Cadastral

Cadastre pelo menos:

- ATIVA
- BAIXADA
- INAPTA
- SUSPENSA
- NULA

A integração procura a opção pelo texto e grava o **ID da opção** no Pipedrive.

## O que a v4 grava

BrasilAPI -> Organização no Pipedrive:

- `razao_social` -> Nome da Organização
- `nome_fantasia` -> Nome Fantasia
- `descricao_situacao_cadastral` -> Situação Cadastral
- `data_situacao_cadastral` -> Data Situação Cadastral
- `cnae_fiscal` -> CNAE Principal
- `cnae_fiscal_descricao` -> Descrição CNAE Principal
- `natureza_juridica` -> Natureza Jurídica
- `qsa[]` -> Quadro Societário (QSA)
- CEP / endereço / município / UF -> endereço padrão da Organização

O QSA é gravado em formato legível, uma linha por sócio/administrador:
`NOME — QUALIFICAÇÃO — Entrada: DD/MM/AAAA`

## Fluxo

1. Valida CNPJ numérico ou alfanumérico.
2. Procura duplicidade no Pipedrive.
3. Se existir, mostra as Organizações encontradas para seleção e vínculo.
4. Se não existir, consulta BrasilAPI.
5. Se a situação não for `ATIVA`, bloqueia a criação.
6. Se estiver `ATIVA`, preenche os dados.
7. Cria Organização + Pessoa/Contato e vincula ambos ao Deal.
8. Grava os campos cadastrais personalizados acima.

Se algum campo personalizado ou opção da Situação Cadastral não for encontrado, a criação continua e o modal mostra um aviso.

## Atualização no Render

Substitua no repositório:
- `server.js`
- `public/modal.html`
- `package.json`
- `README.md`

Depois:
`Manual Deploy -> Deploy latest commit`

Teste:
`https://SEU-SERVICO.onrender.com/health`

O retorno deve conter:
`"version":"4.0.0"`

Não é necessário alterar OAuth callback, URL do iframe, banco ou as variáveis atuais do Render.

## URL do iframe

`https://SEU-SERVICO.onrender.com/modal`
