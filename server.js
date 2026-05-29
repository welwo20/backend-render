require('dotenv').config();
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(cors()); 
app.use(express.json());

const auth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);

const CIDADE_PERMITIDA = "PORCIUNCULA";

function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function extrairCidade(address = {}) {
  return (
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.county ||
    ""
  );
}

function enderecoEhDePorciuncula(...partes) {
  return normalizarTexto(partes.filter(Boolean).join(" ")).includes(CIDADE_PERMITIDA);
}

function montarEnderecoConfirmado(dados = {}) {
  const address = dados.address || {};
  const cidade = extrairCidade(address);
  const bairro =
    address.suburb ||
    address.neighbourhood ||
    address.city_district ||
    address.quarter ||
    "Centro/Geral";
  const logradouro =
    address.road ||
    address.pedestrian ||
    address.footway ||
    address.cycleway ||
    "Logradouro não identificado";

  return {
    cidade,
    bairro,
    logradouro,
    endereco: dados.display_name || "",
    permitido: enderecoEhDePorciuncula(cidade, dados.display_name)
  };
}

// ==========================================
// ROTA PARA CONFIRMAR ENDEREÇO POR COORDENADAS
// ==========================================
app.post('/api/confirmar-endereco', async (req, res) => {
  const { lat, lng } = req.body;

  if (!lat || !lng) {
    return res.status(400).json({ erro: "Latitude e longitude são obrigatórias." });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const response = await axios.get(url, { headers: { 'User-Agent': 'VozUrbana-App' } });

    res.json(montarEnderecoConfirmado(response.data));
  } catch (error) {
    console.error("Erro ao confirmar endereço:", error.message);
    res.status(500).json({ erro: "Não foi possível confirmar o endereço." });
  }
});

// ==========================================
// 1. ROTA PARA REGISTRAR/APOIAR INCIDENTES
// ==========================================
app.post('/api/incidentes', async (req, res) => {
  const { lat, lng, categoria, descricao, rua, logradouro, bairro, bairroConfirmado, cidadeConfirmada, modoLocalizacao } = req.body;
  const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const response = await axios.get(url, { headers: { 'User-Agent': 'VozUrbana-App' } });
    
    const addr = response.data && response.data.address ? response.data.address : {};
    const cidadeDetectada = extrairCidade(addr) || cidadeConfirmada;

    if (!enderecoEhDePorciuncula(cidadeDetectada, cidadeConfirmada, response.data.display_name)) {
      return res.status(403).json({ erro: "Relatos permitidos apenas em Porciúncula-RJ." });
    }
    
    // Prioriza o que o GPS achou, senão usa o que o frontend enviou
    const finalRua = addr.road || rua || logradouro || "Rua não identificada";
    const finalBairro = addr.suburb || addr.neighbourhood || bairro || bairroConfirmado || "Centro";
    const cidade = "Porciúncula-RJ";

    const idAgrupador = `${categoria}_${finalRua}_${finalBairro}`.toLowerCase().replace(/\s+/g, '-');

    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // Verifica se este IP já interagiu com este ID específico
    const jaVotou = rows.find(r => 
      r.get('ID_Agrupador') === idAgrupador && 
      String(r.get('IPs_Apoiadores') || "").includes(userIP)
    );

    if (jaVotou) return res.status(409).json({ erro: "Você já relatou ou apoiou este problema aqui." });

    const incidenteAtivo = rows.find(r => 
      r.get('ID_Agrupador') === idAgrupador && r.get('Status') !== 'Resolvido'
    );

    if (incidenteAtivo) {
      incidenteAtivo.set('Apoios', parseInt(incidenteAtivo.get('Apoios') || 1) + 1);
      const ips = incidenteAtivo.get('IPs_Apoiadores') || "";
      incidenteAtivo.set('IPs_Apoiadores', ips ? `${ips}, ${userIP}` : userIP);
      await incidenteAtivo.save();
      return res.status(200).json({ sucesso: true, mensagem: "Apoio registrado!", bairro: finalBairro });
    }

    await sheet.addRow({
      DataHora: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      ID_Agrupador: idAgrupador,
      Categoria: categoria,
      Descricao: descricao || "",
      Rua: finalRua,
      Logradouro: finalRua,
      Bairro: finalBairro,
      Cidade: cidade,
      Endereco: response.data.display_name || "Endereço manual",
      Apoios: 1,
      Status: 'Pendente',
      IPs_Apoiadores: userIP,
      Latitude: String(lat).replace('.', ','),
      Longitude: String(lng).replace('.', ',')
    });

    res.status(201).json({ sucesso: true, mensagem: "Relato enviado!", bairro: finalBairro });

  } catch (error) {
    console.error("❌ Erro no Servidor:", error.message);
    res.status(500).json({ erro: "Falha ao processar reporte georeferenciado." });
  }
});

//---------- 2. Estatísticas ---------
app.get('/api/estatisticas', async (req, res) => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const total = rows.length;
    const resolvidos = rows.filter(r => String(r.get('Status')).toLowerCase() === 'resolvido').length;
    
    const bairrosUnicos = new Set(rows.map(r => r.get('Bairro')).filter(b => b)).size;

    res.json({ total, resolvidos, bairros: bairrosUnicos || (total > 0 ? 1 : 0) });
  } catch (error) {
    res.status(500).json({ erro: "Erro ao calcular estatísticas" });
  }
});

// ------- 3. Pontos para o Mapa ---------
app.get('/api/pontos-mapa', async (req, res) => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const pontos = rows.map(r => {
        const latRaw = r.get('Latitude');
        const lngRaw = r.get('Longitude');
        if(!latRaw || !lngRaw) return null;

        return {
            lat: parseFloat(String(latRaw).replace(',', '.')),
            lng: parseFloat(String(lngRaw).replace(',', '.')),
            categoria: r.get('Categoria'),
            status: r.get('Status') || 'Pendente',
            bairro: r.get('Bairro'),
            rua: r.get('Rua'),
            apoios: r.get('Apoios')
        };
    }).filter(p => p !== null);

    res.json(pontos);
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao carregar mapa");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 Servidor Voz Urbana rodando na porta ${PORT}`));
