# Voz Urbana JS

Adaptação do projeto Streamlit para um frontend HTML com backend Node.js/Express.

## Como rodar

1. Instale o Node.js 18 ou superior.
2. No terminal, dentro desta pasta, execute:

```bash
npm install
npm start
```

3. Acesse:

```text
http://localhost:3000
```

## Rotas do backend

- `GET /api/health`: verifica se o servidor está online.
- `GET /api/incidents`: lista os relatos cadastrados.
- `GET /api/stats`: retorna estatísticas para os cards.
- `POST /api/incidents`: salva um novo relato.

Os relatos ficam em `data/incidents.json`. O backend mantém a trava de segurança de 60 segundos entre envios por IP, equivalente ao cooldown usado no Streamlit.
