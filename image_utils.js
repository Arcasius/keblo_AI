import sharp from "sharp";
import fs from "fs/promises";

export async function prepareImage(filePath) {
  console.log("[VISION] Path ricevuto:", filePath);

  try {
    const buffer = await fs.readFile(filePath);

    console.log("[VISION] File letto, size:", buffer.length);

    const resized = await sharp(buffer)
      .resize({
        width: 1280,
        height: 1280,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    return resized.toString("base64");

  } catch (err) {
    console.error("[VISION ERROR] Lettura immagine fallita:", err.message);
    throw err;
  }
}
