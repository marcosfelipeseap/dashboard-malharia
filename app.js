const express = require('express');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const myCache = new NodeCache({ stdTTL: 600 }); // 10 min

// --- AUTENTICAÇÃO BLINDADA PARA VERCEL E LOCAL ---
let auth;
let sheets;
try {
    if (process.env.GOOGLE_CREDENTIALS) {
        console.log("Lendo credenciais do Vercel...");
        let rawCreds = process.env.GOOGLE_CREDENTIALS;
        let credsObj;
        
        try {
            // Tentativa 1: O Vercel enviou o JSON limpo
            credsObj = JSON.parse(rawCreds);
        } catch (e1) {
            // Tentativa 2: O Vercel adicionou aspas em volta da string toda (comum em deploy)
            console.log("Limpando aspas invisíveis do Vercel...");
            rawCreds = rawCreds.trim();
            if ((rawCreds.startsWith('"') && rawCreds.endsWith('"')) || (rawCreds.startsWith("'") && rawCreds.endsWith("'"))) {
                rawCreds = rawCreds.substring(1, rawCreds.length - 1);
            }
            credsObj = JSON.parse(rawCreds);
        }

        // Garante que a chave privada seja lida corretamente (O Google Auth exige \n real)
        let privateKey = credsObj.private_key;
        if (privateKey && privateKey.includes('\\n')) {
            privateKey = privateKey.replace(/\\n/g, '\n');
        }

        auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credsObj.client_email,
                private_key: privateKey,
                project_id: credsObj.project_id
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
    } else {
        console.log("Lendo arquivo credentials.json local...");
        auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
    }
    sheets = google.sheets({ version: 'v4', auth });
    console.log("✅ API do Google conectada com sucesso!");
} catch (error) {
    console.error("❌ ERRO CRÍTICO NA LEITURA DA CHAVE:", error.message);
}

// --- FUNÇÃO BLINDADA PARA DATAS ---
function normalizeDate(val) {
    if (val === null || val === undefined || val === "") return "";
    
    // Trata Número de Série do Excel/Google Sheets (ex: 45398)
    if (typeof val === 'number' || (typeof val === 'string' && !isNaN(val) && Number(val) > 40000)) {
        let serial = Number(val);
        let utc_days = Math.floor(serial - 25569);
        let date_info = new Date(utc_days * 86400 * 1000);
        let day = String(date_info.getUTCDate()).padStart(2, '0');
        let month = String(date_info.getUTCMonth() + 1).padStart(2, '0');
        let year = date_info.getUTCFullYear();
        return `${day}/${month}/${year}`;
    }

    let str = String(val).trim().split(' ')[0]; 
    if (str.toLowerCase() === "invalid date") return "";

    // Trata formato DD/MM/YYYY ou YYYY/MM/DD
    if (str.includes('/')) {
        let parts = str.split('/');
        if (parts.length === 2) {
            return `${parts[0].trim().padStart(2, '0')}/${parts[1].trim().padStart(2, '0')}/${new Date().getFullYear()}`;
        }
        if (parts.length >= 3) {
            let p0 = parts[0].trim().padStart(2, '0');
            let p1 = parts[1].trim().padStart(2, '0');
            let p2 = parts[2].trim();
            if (p2.length === 2) p2 = "20" + p2;
            if (p0.length === 4) return `${parts[2].trim().padStart(2, '0')}/${p1}/${p0}`;
            return `${p0}/${p1}/${p2.substring(0,4)}`;
        }
    }
    
    // Trata formato YYYY-MM-DD ou DD-MM-YYYY
    if (str.includes('-')) {
        let parts = str.split('-');
        if (parts.length >= 3) {
            let p0 = parts[0].trim();
            let p1 = parts[1].trim().padStart(2, '0');
            let p2 = parts[2].trim();
            if (p0.length === 4) return `${p2.padStart(2, '0')}/${p1}/${p0}`;
            if (p2.length === 2) p2 = "20" + p2;
            return `${p0.padStart(2, '0')}/${p1}/${p2.substring(0,4)}`;
        }
    }
    return str;
}

function parseNumber(val) {
    if (typeof val === 'string') {
        let clean = val.replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
        return parseFloat(clean) || 0;
    }
    return val || 0;
}

// --- LÓGICA DE BUSCA DE DADOS ---
async function fetchDataFromSheets() {
    if (!sheets) throw new Error("API do Google não inicializada. Verifique os Logs do Vercel.");
    
    const spreadsheetId = '1GU1b3QiOh9sSisqI3g-a2MoR5mTESD_jaTt_tOH5QjA';
    
    const ranges = [
        'Relatórios!A:T', 'ListaOficinas!A:H', 'Controle - Detalhado!A:P', 
        'DEMANDA - UPFEM!A:M', 'Fardamento Interno - Novo!A:G', 'Fardamento Servidor!A:G'
    ];
    
    const responses = await Promise.all(ranges.map(range => 
        sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'FORMATTED_VALUE' })
            .catch(() => ({ data: { values: [] } }))
    ));

    const [valRelatorios, valOficinas, valCtrl, valUpfem, valFardInt, valFardSeap] = responses.map(r => r.data.values || []);

    const result = {
        sheetData: processSheetData(valRelatorios),
        oficinasData: processOficinasInfo(valOficinas),
        processData: processProcessData(valCtrl),
        scheduleData: processScheduleData(valUpfem, valCtrl),
        fardData: processFardamentoData(valFardInt),
        fardSeapData: processFardamentoSeapData(valFardSeap)
    };
    return result;
}

// --- PROCESSADORES DE CADA ABA ---
function processSheetData(values) {
    if (values.length < 2) return [];
    return values.slice(1).map(row => {
        let dataStr = normalizeDate(row[0]);
        let oficina = String(row[2] || "").trim();
        let item = String(row[6] || "").trim();
        if (!dataStr || !oficina || !item) return null;
        return {
            data: dataStr, oficina, maquinas: String(row[5] || "0").trim(),
            internosVinc: parseNumber(row[4]), item, tipo: String(row[7] || "").trim(),
            internos: parseNumber(row[12]), metaOficina: parseNumber(row[14]),
            producaoDia: parseNumber(row[15]), status: row[18], justificativa: row[19]
        };
    }).filter(i => i !== null && i.tipo !== "");
}

function processOficinasInfo(values) {
    if (values.length < 2) return [];
    return values.slice(1).map(row => ({
        nome: String(row[1] || "").trim(), remunerados: parseNumber(row[7])
    })).filter(i => i.nome !== "");
}

function processProcessData(values) {
    if (values.length < 2) return [];
    return values.slice(1).map(row => {
        let nProcRaw = String(row[2] || "").trim();
        let nProc = nProcRaw ? nProcRaw.replace(/\./g, '') : "S/N"; 
        
        return {
            tipoDemanda: row[0], dataEntrada: normalizeDate(row[1]), nProcesso: nProc,
            orgao: row[3], produto: row[4], qtdSolicitada: parseNumber(row[5]),
            qtdAutorizada: parseNumber(row[6]), prazo: normalizeDate(row[7]),
            qtdEntregue: parseNumber(row[8]), qtdFaltante: parseNumber(row[9]),
            dataTermos: normalizeDate(row[10]), status: row[11], situacao: row[12],
            obs: row[13], linkSei: String(row[15] || "").trim()
        };
    }).filter(i => i !== null);
}

function processScheduleData(rawUpfem, rawCtrl) {
    let dataUpfem = [], upfemProcessSet = {}, dataCtrl = [];
    
    if (rawUpfem.length > 1) {
        dataUpfem = rawUpfem.slice(1).map(r => {
            let nProcRaw = String(r[1] || "").trim(); 
            let nProc = nProcRaw ? nProcRaw.replace(/\./g, '') : "S/N"; 
            
            let isGeneric = nProc === "S/N" || nProc.toUpperCase() === "SEM PROCESSO" || nProc === "-";
            if (!isGeneric) {
                upfemProcessSet[nProc.toUpperCase()] = true;
            }
            
            let dataPrazo = normalizeDate(r[11]); 
            if (!dataPrazo) return null; 
            
            return { source: 'UPFEM', nProcesso: nProc, orgao: r[2], produto: r[3], tamanho: r[4], qtdPendente: parseNumber(r[8]), prazo: dataPrazo, status: r[9], situacao: r[10], obs: r[12] };
        }).filter(i => i !== null);
    }
    
    if (rawCtrl.length > 1) {
        dataCtrl = rawCtrl.slice(1).map(r => {
            let rawProcRaw = String(r[2] || "").trim();
            let rawProc = rawProcRaw ? rawProcRaw.replace(/\./g, '') : "S/N"; 
            
            let isGeneric = rawProc === "S/N" || rawProc.toUpperCase() === "SEM PROCESSO" || rawProc === "-";
            
            if (!isGeneric && upfemProcessSet[rawProc.toUpperCase()]) return null;
            
            let dataPrazo = normalizeDate(r[7]); 
            if (!dataPrazo) return null; 
            
            return { source: 'CTRL', nProcesso: rawProc, orgao: r[3], produto: r[4], tamanho: '-', qtdPendente: parseNumber(r[9]), prazo: dataPrazo, status: r[11], situacao: r[12], obs: r[13] };
        }).filter(i => i !== null);
    }

    let allItems = dataUpfem.concat(dataCtrl).filter(i => i && i.prazo);
    let groups = {};
    
    allItems.forEach(item => {
        let uniqueKey = `${item.nProcesso}_${item.prazo}`;
        if (!groups[uniqueKey]) groups[uniqueKey] = { nProcesso: item.nProcesso, orgao: item.orgao, prazo: item.prazo, items: [], totalPendente: 0 };
        groups[uniqueKey].items.push(item);
        groups[uniqueKey].totalPendente += item.qtdPendente;
    });
    
    return Object.values(groups);
}

function processFardamentoData(values) {
    if (values.length < 2) return [];
    return values.slice(1).map(row => {
        let dataStr = normalizeDate(row[0]);
        if (!dataStr) return null;
        return { data: dataStr, mesAno: String(row[1] || "").trim(), tipo: String(row[2] || "").trim(), cor: String(row[3] || "").trim(), quantidade: parseNumber(row[4]), destino: String(row[5] || "").trim(), observacao: String(row[6] || "").trim() };
    }).filter(i => i !== null && i.tipo !== "");
}

function processFardamentoSeapData(values) {
    if (values.length < 2) return [];
    return values.slice(1).map(row => {
        let dataStr = normalizeDate(row[0]);
        if (!dataStr) return null;
        return { data: dataStr, mesAno: String(row[1] || "").trim(), tipo: String(row[2] || "").trim(), tamanho: String(row[3] || "").trim(), quantidade: parseNumber(row[4]), destino: String(row[5] || "").trim(), observacao: String(row[6] || "").trim() };
    }).filter(i => i !== null && i.tipo !== "");
} 

// --- ROTAS ---
app.get('/', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        let data = myCache.get('MALHARIA_DATA');

        if (!data || forceRefresh) {
            console.log("Buscando dados no Google Sheets (Malharia)...");
            data = await fetchDataFromSheets();
            myCache.set('MALHARIA_DATA', data);
        }
        res.render('index', { INITIAL_DATA: JSON.stringify(data) });
    } catch (err) {
        console.error(err);
        res.status(500).send("Erro ao carregar painel: " + err.message);
    }
});

app.get('/api/data', async (req, res) => {
    try {
        const data = await fetchDataFromSheets();
        myCache.set('MALHARIA_DATA', data);
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Impede que o Vercel "tranque" o servidor
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Malharia rodando localmente em http://localhost:${PORT}`));
}

module.exports = app;