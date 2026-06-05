import fetch from "node-fetch";

async function testSerper() {
  const key = "92ea2ca046165295f5de47da8aa3712837e7473b"; // La tua chiave
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: "milan" })
  });

  const data = await res.json();
  console.log("Risultato:", data);
}

testSerper();