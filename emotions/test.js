// test_parser.js
import { parseEmotionFromText } from "./emotion_parse.js";
import fetch from "node-fetch";

// Configurazione (assicurati che siano uguali al tuo server)
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "gpt-oss:20b"; 

// Funzione finta per simulare la chiamata LLM del server
async function mockCallLLM(prompt) {
    console.log("\n--- INVIANDO PROMPT AD OLLAMA ---");
    const response = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: MODEL,
            prompt: prompt,
            stream: false,
            options: { temperature: 0.01 }
        })
    });
    const data = await response.json();
    return data.response;
}

async function runTest() {
    const testFrase = "Jace, sono davvero incazzato perché questo codice mi sta facendo impazzire e sono stanchissimo!";
    
    console.log(`\nTESTING FRASE: "${testFrase}"`);
    
    const result = await parseEmotionFromText(testFrase, mockCallLLM);
    
    console.log("\n--- RISULTATO FINALE DEL PARSER ---");
    console.log(JSON.stringify(result, null, 2));
}

runTest();