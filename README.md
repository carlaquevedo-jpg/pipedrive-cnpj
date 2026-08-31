# Pipedrive CNPJ MVP v5

A v5 muda o fluxo principal: **o cliente é preparado antes do Deal existir**.

## Fluxo novo

1. Usuário abre a janela flutuante **Cadastrar cliente** no Pipedrive.
2. Informa o CNPJ.
3. O backend procura o CNPJ no Pipedrive.
4. Se a Organização já existir:
   - usuário seleciona a Organização;
   - o app lista Pessoas já vinculadas à Organização;
   - usuário pode selecionar uma Pessoa existente ou criar um novo contato.
5. Se a Organização não existir:
   - consulta BrasilAPI;
   - valida situação cadastral;
   - preenche dados cadastrais;
   - cria Organização e Pessoa.
6. Com Organização + Pessoa prontas, o botão **Abrir novo negócio** abre o modal nativo do Pipedrive.
7. O modal nativo recebe pré-preenchimento de Título, Organização e Pessoa.
8. Depois que o Deal é salvo, o app redireciona para o negócio criado.

## Extensão a criar no Developer Hub

Em **App extensions**, adicione uma **Janela flutuante personalizada**:

- Nome: `Cadastrar cliente`
- Descrição: `Valide o CNPJ, selecione ou crie a empresa e o contato antes de abrir um novo negócio.`
- URL de iframe: `https://SEU-SERVICO.onrender.com/floating`
- Chave JWT: deixe vazia se quiser usar o Client Secret como padrão
- Ponto de entrada: **Top bar / Apps dock**

A Custom Modal antiga em `/modal` pode continuar instalada durante os testes; a v5 não a remove.

## Campos personalizados esperados na Organização

- `CNPJ` — Texto
- `Nome Fantasia` — Texto
- `Situação Cadastral` — Opção única
- `Data Situação Cadastral` — Data
- `CNAE Principal` — Texto ou Texto longo
- `Descrição CNAE Principal` — Texto longo
- `Natureza Jurídica` — Texto longo
- `Quadro Societário (QSA)` — Texto longo

Opções sugeridas em `Situação Cadastral`:

- ATIVA
- BAIXADA
- INAPTA
- SUSPENSA
- NULA

## Endpoints novos da v5

- `GET /floating` — interface da janela flutuante
- `POST /api/persons-by-organization` — lista contatos de uma Organização
- `POST /api/create-contact-existing` — cria contato para Organização existente
- `POST /api/create-client` — cria Organização + Pessoa, sem Deal

Os endpoints da v4 continuam disponíveis para o modal legado.

## Observação sobre o modal nativo de Deal

O SDK atual do Pipedrive permite pré-preencher o novo Deal com **nomes** de Organização e Pessoa (`prefill.organization` e `prefill.person`), não com IDs. Para o MVP isso é útil, mas confirme visualmente os dois campos no modal nativo antes de salvar, principalmente se houver nomes idênticos no CRM.

## Atualização no Render

Substitua no GitHub:

- `server.js`
- `public/floating.html`
- `public/modal.html` (pode manter o da v4)
- `package.json`
- `README.md`

Depois no Render:

`Manual Deploy -> Deploy latest commit`

Teste:

`https://SEU-SERVICO.onrender.com/health`

O retorno deve conter:

`"version":"5.0.0"`

Não é necessário mudar OAuth callback, banco ou variáveis já existentes.
