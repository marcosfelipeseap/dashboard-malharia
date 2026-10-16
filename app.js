const express = require('express');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const axios = require('axios'); // Caso não tenha, execute npm install axios ou usaremos fetch nativo do Node

dotenv.config();
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(cookieParser());

// Permite que o servidor sirva arquivos estáticos da pasta public (onde está sua logo)
app.use(express.static(path.join(__dirname, 'public')));

const myCache = new NodeCache({ stdTTL: 600 }); // 10 min

const PORTAL_URL = 'https://menuugtr.vercel.app';

// --- MIDDLEWARE DE PROTEÇÃO SSO (8 HORAS) ---
async function verificarSSO(req, res, next) {
    const ssoToken = req.query.sso_token;
    const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    // 1. Se veio um token fresco na URL (veio do Menu ou redirecionado do login)
    if (ssoToken) {
        try {
            // Valida o token na API do Portal Central
            const response = await fetch(`${PORTAL_URL}/api/sso/verificar?token=${encodeURIComponent(ssoToken)}`);
            const dados = await response.json();

            if (dados && dados.valido) {
                // Salva o token em um cookie seguro por 8 horas
                res.cookie('seap_sso_malharia', ssoToken, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: 'lax',
                    maxAge: 8 * 60 * 60 * 1000 // 8 horas
                });

                // Remove o ?sso_token da barra de endereços para limpar a URL
                const cleanUrl = req.protocol + '://' + req.get('host') + req.path;
                return res.redirect(cleanUrl);
            }
        } catch (e) {
            console.error("Erro ao validar SSO:", e.message);
        }
    }

    // 2. Se não tem na URL, verifica se o cookie de sessão de 8 horas existe
    const cookieToken = req.cookies.seap_sso_malharia;
    if (cookieToken) {
        try {
            const response = await fetch(`${PORTAL_URL}/api/sso/verificar?token=${encodeURIComponent(cookieToken)}`);
            const dados = await response.json();
            if (dados && dados.valido) {
                return next(); // Sessão válida!
            }
        } catch (e) {}
    }

    // 3. Não autenticado: Exibe a página elegante de Acesso Restrito com o botão de Login
    const urlLogin = `${PORTAL_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;
    
    return res.status(401).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Acesso Restrito - SEAP</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #ecf0f3; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .box { background: #fff; padding: 40px 35px; border-radius: 18px; box-shadow: 0 12px 30px rgba(0,0,0,0.12); text-align: center; max-width: 400px; width: 90%; }
                h3 { color: #044c14; margin-top: 0; font-size: 22px; }
                p { color: #64748B; font-size: 14px; margin-bottom: 25px; line-height: 1.5; }
                .btn { display: inline-block; padding: 13px 28px; background: linear-gradient(120deg, #044c14, #0a7d2a); color: #fff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; transition: transform 0.2s, box-shadow 0.2s; }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(10, 125, 42, 0.3); }
            </style>
            <script>
                // Tenta redirecionar automaticamente se permitido pelo navegador
                setTimeout(function() {
                    window.top.location.href = "${urlLogin}";
                }, 1500);
            </script>
        </head>
        <body>
            <div class="box">
                <h3>🔒 Acesso Restrito</h3>
                <p>Você precisa estar autenticado no Portal de Sistemas SEAP para visualizar este painel. Redirecionando para o login...</p>
                <a class="btn" href="${urlLogin}" target="_top">Ir para o Login</a>
            </div>
        </body>
        </html>
    `);
}

// --- AUTENTICAÇÃO BLINDADA PARA VERCEL E LOCAL ---
let auth;
let sheets;
try {
    if (process.env.GOOGLE_CREDENTIALS) {
        console.log("Lendo credenciais do Vercel...");
        let rawCreds = process.env.GOOGLE_CREDENTIALS;
        let credsObj;
        
        try {
            credsObj = JSON.parse(rawCreds);
        } catch (e1) {
            console.log("Limpando aspas invisíveis do Vercel...");
            rawCreds = rawCreds.trim();
            if ((rawCreds.startsWith('"') && rawCreds.endsWith('"')) || (rawCreds.startsWith("'") && rawCreds.endsWith("'"))) {
                rawCreds = rawCreds.substring(1, rawCreds.length - 1);
            }
            credsObj = JSON.parse(rawCreds);
        }

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
        sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'UNFORMATTED_VALUE' })
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
            producaoDia: parseNumber(row[15]), status: String(row[18] || ""), justificativa: String(row[19] || "")
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
            tipoDemanda: String(row[0] || ""), dataEntrada: normalizeDate(row[1]), nProcesso: nProc,
            orgao: String(row[3] || ""), produto: String(row[4] || ""), qtdSolicitada: parseNumber(row[5]),
            qtdAutorizada: parseNumber(row[6]), prazo: normalizeDate(row[7]),
            qtdEntregue: parseNumber(row[8]), qtdFaltante: parseNumber(row[9]),
            dataTermos: normalizeDate(row[10]), status: String(row[11] || ""), situacao: String(row[12] || ""),
            obs: String(row[13] || ""), linkSei: String(row[15] || "").trim()
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
            
            return { source: 'UPFEM', nProcesso: nProc, orgao: String(r[2] || ""), produto: String(r[3] || ""), tamanho: String(r[4] || ""), qtdPendente: parseNumber(r[8]), prazo: dataPrazo, status: String(r[9] || ""), situacao: String(r[10] || ""), obs: String(r[12] || "") };
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
            
            return { source: 'CTRL', nProcesso: rawProc, orgao: String(r[3] || ""), produto: String(r[4] || ""), tamanho: '-', qtdPendente: parseNumber(r[9]), prazo: dataPrazo, status: String(r[11] || ""), situacao: String(r[12] || ""), obs: String(r[13] || "") };
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

// --- ROTAS (PROTEGIDAS PELO MIDDLEWARE SSO) ---
app.get('/', verificarSSO, async (req, res) => {
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

app.get('/api/data', verificarSSO, async (req, res) => {
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