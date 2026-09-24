/**
 * lib/intent.js
 * Local k-NN intent classifier over multilingual embeddings: is a message a
 * support request, casual chat, or an unrelated task ("write me code")?
 * Built-in examples (es/en/pt) cover the generic case; each guild adds its
 * own through the "FyrxAI: ..." message context-menu commands, and those
 * outweigh the built-ins, so it learns the server's own way of talking.
 * No generative model, no API call.
 */

const { embed, dot } = require('./embeddings');

const LABELS = ['support', 'chat', 'task'];
const K = 7;
const GUILD_WEIGHT = 1.5; // a server's own labelled examples beat the generic ones

const SEED = {
    support: [
        'no puedo entrar al servidor', 'me sale un error al conectarme', 'cómo instalo el plugin?',
        'qué comandos hay?', 'que comandos tiene el bot', 'cómo activo premium?', 'me banearon, qué hago?',
        'por qué no me deja entrar con vpn', 'dónde descargo la última versión', 'el plugin no carga al iniciar',
        'se me crashea el juego al entrar', 'cómo vinculo mi cuenta', 'olvidé mi contraseña, cómo la recupero',
        'no me llegó lo que compré', 'cómo cambio el idioma', 'para qué sirve este comando', 'cómo configuro los permisos',
        'no funciona el comando', 'alguien sabe por qué me sale este error?', 'qué versión necesito para entrar',
        'how do I install it?', "I can't connect to the server", 'what are the commands?', 'I got banned, what can I do',
        'how do I get premium', 'the plugin is not working', 'where can I download it', 'how do I link my account',
        'não consigo entrar no servidor', 'como eu ativo o premium?', 'o plugin não funciona', 'quais são os comandos?',
        'tengo un problema con mi cuenta', 'me sale que el servidor está lleno', 'cómo reporto a un jugador',
        'no me aparecen mis cosas', 'se me borró el inventario', 'cómo me uno a un clan', 'cuánto cuesta el vip?',
        'es gratis jugar?', 'qué ip tiene el servidor', 'cómo subo de rango', 'me expulsaron sin razón',
        'no me deja registrarme', 'me dice cuenta no encontrada', 'cómo apelo un baneo', 'el launcher no abre',
        'cuáles son las reglas', 'cómo reclamo mi recompensa', 'se me desconecta a cada rato', 'hay lag, qué hago',
        'ayuda, no me funciona el login', 'alguien me explica cómo se usa /spawn', 'cómo se configura esto?',
        'does it support bedrock?', 'why do I get kicked when joining', 'is it free to play?', 'how do I appeal a ban',
        'my purchase did not arrive', 'how do I change my password', 'what version do I need'
    ],
    chat: [
        'jajaja', 'xd', 'buenas a todos', 'hola que tal', 'bueno', 'va', 'ok gracias', 'jaja qué risa',
        'espérame un momento', 'ahora vuelvo', 'estoy editando el canal', 'luego subo lo demás',
        'ya lo probé y funciona', 'ese tipo es un payaso', 'qué buena partida', 'no me gustó cómo quedó',
        'eso está muy bien', 'lo voy a probar después', 'a ver qué tal sale esta vez', 'no sé, ya veremos',
        'pues a mí me pasó lo mismo ayer', 'mañana lo reviso', 'jajaja qué malo es ese bot',
        'lol', 'good morning everyone', 'nice, thanks', 'brb', "that's funny", 'I will try it later',
        'bom dia pessoal', 'kkkkkk', 'valeu',
        'estoy cambiando la configuración del bot', 'voy a meterle más cosas a la wiki', 'ya actualicé el canal',
        'luego le pongo más ejemplos', 'no me convence cómo responde', 'este bot no sirve jaja', 'qué lento está esto',
        'le voy a poner más reglas', 'ya casi termino', 'me está costando mucho dinero esto', 'qué raro lo que hizo',
        'pues no sé qué pasó', 'mira lo que respondió jaja', 'ya lo arreglo yo', 'déjame ver', 'sí, eso',
        'no, así no', 'claro que sí', 'tienes razón', 'eso digo yo', 'uff qué cansado', 'nos vemos luego',
        'I am updating the docs', 'let me check', 'yeah exactly', 'this bot is dumb lol', 'ok I will fix it',
        'tô mexendo no bot', 'beleza'
    ],
    task: [
        'crea un comando en python que diga hola mundo', 'hazme un script en javascript', 'arregla este código',
        'por qué falla mi código de java?', 'escríbeme un poema', 'cuál es la capital de francia?',
        'resuelve esta ecuación', 'hazme la tarea de historia', 'traduce este texto al inglés',
        'explícame cómo funciona la fotosíntesis', 'dame una receta de pizza', 'recomiéndame una película',
        'qué hago si me duele la cabeza', 'cuéntame un chiste', 'genera una imagen de un gato',
        'write a python script that prints hello world', 'debug my code please', 'write me an essay',
        'what is the capital of spain', 'solve this math problem', 'tell me a joke', 'create a discord bot for me',
        'faz um código em python', 'me ajuda com meu dever de casa',
        'escribe una función que sume dos números', 'cómo hago un for en python', 'qué es una api rest',
        'hazme un logo', 'dame ideas para un nombre', 'resume este texto', 'quién ganó el mundial',
        'cómo cocino arroz', 'qué opinas de la política', 'explícame la teoría de la relatividad',
        'optimize this sql query', 'how do I center a div', 'give me a workout plan', 'write a cover letter'
    ]
};

let seedPromise = null;
const guildVecCache = new Map(); // text -> vector, for guild-trained examples

function seedVectors() {
    if (!seedPromise) {
        seedPromise = (async () => {
            const out = [];
            for (const label of LABELS) {
                for (const text of SEED[label]) {
                    const v = await embed(text);
                    if (!v) return null;
                    out.push({ label, v, w: 1 });
                }
            }
            return out;
        })();
    }
    return seedPromise;
}

async function guildVectors(examples = []) {
    const out = [];
    for (const { text, label } of examples) {
        if (!guildVecCache.has(text)) guildVecCache.set(text, await embed(text));
        const v = guildVecCache.get(text);
        if (v) out.push({ label, v, w: GUILD_WEIGHT });
    }
    return out;
}

/**
 * @param {string} text
 * @param {Array<{text: string, label: string}>} guildExamples - config.trainingExamples
 * @returns {Promise<{label: string, confidence: number, similarity: number}|null>} null if the model is unavailable
 */
async function classifyIntent(text, guildExamples) {
    const seeds = await seedVectors();
    if (!seeds) return null;
    const v = await embed(text);
    if (!v) return null;

    const neighbours = [...seeds, ...(await guildVectors(guildExamples))]
        .map(e => ({ label: e.label, sim: dot(v, e.v), w: e.w }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, K);

    const votes = Object.fromEntries(LABELS.map(l => [l, 0]));
    let total = 0;
    for (const n of neighbours) {
        const weight = Math.max(n.sim, 0) * n.w;
        votes[n.label] += weight;
        total += weight;
    }
    const [label, score] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    return { label, confidence: total ? score / total : 0, similarity: neighbours[0]?.sim || 0 };
}

module.exports = { classifyIntent, LABELS };
