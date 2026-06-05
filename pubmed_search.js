import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "keblo_med",
  user: "keblo",
  password: "keblo123",
});

function normalizeQuery(q = "") {
  return q
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export async function searchPubmed(query, { lastYears = 10, limit = 10 } = {}) {
  const cleanQuery = normalizeQuery(query);
  if (!cleanQuery) return [];

  const currentYear = new Date().getFullYear();
  const minYear = currentYear - lastYears;

  const dictionary = {
    epilessia: "epilepsy",
    sindrome: "syndrome",
    cannabinoidi: "cannabinoids",
    cannabis: "cannabis",
    studi: "",
    studio: "",
    articoli: "",
    articolo: "",
    ricerca: "",
    recenti: "",
    ultimi: ""
  };

  const words = cleanQuery
    .split(/\s+/)
    .map(w => dictionary[w.toLowerCase()] ?? w)
    .map(w => w.trim())
    .filter(w => w.length > 2);

  if (!words.length) return [];

  const conditions = words
    .map((_, i) => `(title ILIKE $${i + 1} OR abstract ILIKE $${i + 1})`)
    .join(" AND ");

  const sql = `
    SELECT pmid, title, abstract, year, journal
    FROM pubmed_articles
    WHERE
      ${conditions}
      AND (year IS NULL OR year >= $${words.length + 1})
    ORDER BY year DESC NULLS LAST
    LIMIT $${words.length + 2}
  `;

  const values = words.map(w => `%${w}%`);
  values.push(minYear, limit);

  const res = await pool.query(sql, values);
  return res.rows;
}

export async function healthPubmed() {
  const res = await pool.query("SELECT COUNT(*)::int AS total FROM pubmed_articles");
  return res.rows[0];
}