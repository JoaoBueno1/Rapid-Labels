# Por que a `dev` não funcionava no outro PC

Escrito em 2026-08-31, depois de o Inventory Management abrir vazio numa
segunda máquina com o mesmo código da `dev`.

**Resumo:** não era código. Eram duas coisas que não viajam com o `git pull` —
o arquivo `.env` e o `localStorage` do navegador.

---

## 1. A causa principal: falta `SUPABASE_DB_PASSWORD` no `.env`

O Stock Planning fala **direto com o Postgres**, não pelo PostgREST. Quem abre
essa conexão é `features/stock-planning/lib/sp-db.js`, e ele precisa de:

```
SUPABASE_URL=https://<projeto>.supabase.co
SUPABASE_DB_PASSWORD=<a senha do banco>
```

(ou `SUPABASE_DB_URL` sozinho, que já traz tudo.)

Sem isso, `sp-db` devolve `null` na configuração e **toda** rota
`/api/stock-planning/*` falha. Na tela isso não vira erro vermelho: vira lista
vazia. Estas cinco abrem e ficam em branco:

- Stock Planning
- Projects
- Purchase Orders
- Master Stock
- Monthly Review

O `.env` **nunca foi commitado** — e está certo assim: o repositório é público
(`github.com/JoaoBueno1/Rapid-Labels`) e não existe `.vercelignore`, então
qualquer arquivo commitado fica acessível. Por isso ele não chega pelo `git
pull`: tem de ser copiado à mão de uma máquina que funcione.

O `.env.example` já lista todas as variáveis necessárias. A armadilha é ter um
`.env` **antigo**, de antes do Stock Planning existir: ele tem `SUPABASE_URL` e
`SUPABASE_SERVICE_KEY`, o servidor sobe, o Dashboard e a reposição funcionam —
e só o Inventory Management fica vazio. Foi exatamente esse o caso.

### Como saber, agora, em 5 segundos

O servidor passou a gritar no boot. Se faltar a credencial, aparece isto ao
rodar `npm start`:

```
  ┌───────────────────────────────────────────────────────────────┐
  │  SEM CREDENCIAL DE BANCO — Inventory Management não vai abrir │
  └───────────────────────────────────────────────────────────────┘
  Sem estas telas: Stock Planning · Projects · Purchase Orders ·
  Master Stock · Monthly Review. Elas carregam e ficam vazias.
  (Branch Replenishment funciona: ele lê por RPC e não usa senha.)

  Falta no .env: SUPABASE_DB_PASSWORD junto de SUPABASE_URL,
  ou SUPABASE_DB_URL sozinho. Copie de outra máquina que funcione.
```

E a Branch Replenishment tem o aviso dela, porque depende de outras duas:

```
⚠️  Branch Replenishment: falta SUPABASE_URL e SUPABASE_SERVICE_KEY.
    As médias por filial e por rep vão vir VAZIAS nesta máquina, e a tela
    vai parecer que não há nada a repor. Copie o .env antes de usar.
```

### O conserto

Copie o `.env` da máquina que funciona. Confira que ele tem, no mínimo:

```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_DB_PASSWORD=
SUPABASE_DB_HOST=
SUPABASE_DB_PORT=
CIN7_ACCOUNT_ID=
CIN7_API_KEY=
```

Reinicie o servidor e confirme que **nenhum** dos dois avisos acima aparece.

---

## 2. Por que os números de Sydney não batiam entre as duas máquinas

Esse é outro problema, e não tem nada a ver com credencial. A Branch
Replenishment guarda as configurações no **`localStorage` do navegador**, sob a
chave `rp.set`. Duas máquinas com configurações diferentes mostram números
diferentes com o mesmo código e o mesmo banco.

Havia um agravante: a opção `avgSource` continuava salva no `localStorage`
depois de o seletor dela ter sumido da tela. Ela mudava o número e **não era
visível em lugar nenhum** — não dava nem para saber que estava ligada.

Consertado:

- `avgSource` volta ao padrão sozinha, com um aviso no console dizendo que foi
  trocada e por quê;
- a migração passou a **gravar** o valor corrigido de volta (antes ela corrigia
  na memória e o `localStorage` continuava com o valor velho para sempre);
- a régua que está valendo aparece na tela — nos cartões da filial e no rodapé
  da grade — então uma configuração diferente entre máquinas fica visível.

### Como zerar, se desconfiar

No console do navegador, na página da reposição:

```js
localStorage.removeItem('rp.set');   // volta ao padrão
location.reload();
```

Os rascunhos de pedido também são locais (`rp.draft.*`) — eles são **por
computador** de propósito, e o rodapé da tela diz isso. Pedido já enviado é
compartilhado; rascunho não.

---

## 3. O que NÃO era o problema

Para não procurar no lugar errado da próxima vez:

- **Não era o banco.** Os dois PCs falam com o mesmo Supabase. Nenhuma migração
  precisa rodar na segunda máquina.
- **Não era a branch.** O código da `dev` era idêntico nos dois.
- **Não era o `npm install`.** As telas vazias vinham de rota falhando por falta
  de credencial, não de dependência faltando.

---

## 4. O que mudou para isto não voltar

| Antes | Agora |
|---|---|
| Sem credencial, as telas abriam vazias em silêncio | O servidor recusa-se a subir calado: dois avisos no boot |
| `avgSource` mudava o número sem aparecer | Volta ao padrão sozinha e avisa no console |
| A migração corrigia na memória e nunca gravava | Grava de volta no `localStorage` |
| A régua em uso não aparecia na tela | Aparece nos cartões e no rodapé da grade |
| Falha ao carregar a demanda virava "zero" | Vira tarja vermelha: *"não peça nada por esta tela até carregar"* |

Essa última é a mais importante. Zero por falha e zero por não haver o que
repor são a mesma tela e decisões opostas — e num controle de estoque a leitura
errada custa caro.
