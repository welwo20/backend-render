require('dotenv').config();
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();

//cors para permitir o HTML (porta 5500 ou live server) 
// acessar o Node (porta 3000) sem ser bloqueado pelo navegador.
app.use(cors()); 
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Backend Voz Urbana online');
});

// Configuração de Autenticação do Google
const auth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'), // Corrige as quebras de linha
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);

//--------------BUSCAR DADOS----------------
app.get('/api/incidentes', async (req, res) => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    const incidentes = rows.map(row => ({
      latitude: parseFloat(row.get('Latitude')),
      longitude: parseFloat(row.get('Longitude')),
      categoria: row.get('Categoria'),
      descricao: row.get('Descricao'),
      dataHora: row.get('DataHora')
    }));
    
    res.json(incidentes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: "Erro ao buscar dados geográficos." });
  }
});


// Captura GPS -> Converte em Endereço -> Salva na Planilha
app.post('/api/incidentes', async (req, res) => {
  const { lat, lng, categoria, descricao } = req.body;

  try {
    // Geocodificação Reversa (Transforma coord. em endereço)
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'VozUrbana-App' }
    });

    const endereco = response.data.display_name || "Endereço não encontrado";
    // Tenta pegar o bairro de diferentes campos que o Nominatim pode retornar
    const bairro = response.data.address.suburb || 
                   response.data.address.neighbourhood || 
                   response.data.address.city_district || 
                   "Centro/Geral";

    // Preparação para a Planilha
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // FORÇA O FUSO HORÁRIO DE BRASÍLIA
const dataHoraBr = new Date().toLocaleString("pt-BR", {
  timeZone: "America/Sao_Paulo"
});

    // Salvamento Único
    await sheet.addRow({
      DataHora: dataHoraBr.toLocaleString('pt-BR'),
      Categoria: categoria,
      Descricao: descricao || "",
      // Converte para vírgula apenas no salvamento para a planilha aceitar
      Latitude: String(lat).replace('.', ','),
      Longitude: String(lng).replace('.', ','),
      Endereco: endereco,
      Bairro: bairro,
      Status: 'Pendente'
    });

    console.log(`✅ Relato salvo: ${categoria} em ${bairro}`);
    
    // Retorna o bairro para o frontend mostrar no alerta
    res.status(201).json({ 
      sucesso: true, 
      mensagem: "Incidente reportado com sucesso!",
      bairro: bairro 
    });

  } catch (error) {
    console.error("❌ Erro no processo de reporte:", error.message);
    res.status(500).json({ erro: "Falha ao gravar os dados georeferenciados." });
  }
});

//---------- Estatísticas para os cards do frontend---------
app.get('/api/estatisticas', async (req, res) => {
  try {
    // Carrega os dados da planilha
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // Cálculo dos Problemas Reportados (Total de linhas)
    const total = rows.length;
    
    // Cálculo de Bairros Ativos (Coluna 'Endereco')
    const bairrosUnicos = new Set(rows.map(r => {
      const endereco = r.get('Endereco');
      if (endereco && endereco.includes(',')) {
        return endereco.split(',')[1].trim(); // Pega a parte após a vírgula (Bairro)
      }
      return null;
    }).filter(b => b !== null)).size;

   const resolvidos = rows.filter(r => {
      const status = r.get('Status');
      return status && status.trim().toLowerCase() === 'resolvido';
    }).length;

    // Resposta em JSON
    res.json({
      total: total,
      resolvidos: resolvidos,
      bairros: bairrosUnicos || (total > 0 ? 1 : 0)
    });

  } catch (error) {
    console.error("Erro na rota de estatísticas:", error);
    res.status(500).json({ erro: "Falha ao processar dados da planilha" });
  }
});

// ------- Buscar todos os pontos para o mapa ---------
app.get('/api/pontos-mapa', async (req, res) => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // Mapeia as linhas para o formato que o Leaflet entende

const pontos = rows.map(r => {
  // Pega o valor da planilha (Latitude e Longitude)
  let latRaw = r.get('Latitude') || "";
  let lngRaw = r.get('Longitude') || "";

  // FORÇA A CONVERSÃO: Transforma vírgula em ponto e remove espaços
  const latLimpa = String(latRaw).replace(',', '.').trim();
  const lngLimpa = String(lngRaw).replace(',', '.').trim();

  // CONVERTE PARA NÚMERO REAL
  const lat = parseFloat(latLimpa);
  const lng = parseFloat(lngLimpa);

  return {
    lat: lat,
    lng: lng,
    categoria: r.get('Categoria'),
    status: r.get('Status') || 'Pendente'
  };
}).filter(p => !isNaN(p.lat) && !isNaN(p.lng)); // Só envia pro mapa se for um número válido

res.json(pontos);
  } catch (error) {
    res.status(500).json({ erro: "Erro ao carregar pontos do mapa" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
