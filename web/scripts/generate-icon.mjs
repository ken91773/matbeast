import fs from "node:fs/promises";
import path from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const webRoot = process.cwd();
const sourcePng = path.resolve(webRoot, "..", "matbeastlogo.png");
const buildDir = path.resolve(webRoot, "build");
const outputIco = path.resolve(buildDir, "icon.ico");
const normalizedSquarePng = path.resolve(buildDir, "icon-square.png");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  await fs.access(sourcePng);
  await fs.mkdir(buildDir, { recursive: true });

  const image = sharp(sourcePng, { failOn: "none" });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unable to read image dimensions from matbeastlogo.png");
  }

  const size = Math.min(metadata.width, metadata.height);
  await image
    .resize(size, size, {
      fit: "cover",
      position: "center",
    })
    .png()
    .toFile(normalizedSquarePng);

  const pngVariants = [];
  for (const iconSize of iconSizes) {
    const resizedPngPath = path.resolve(buildDir, `icon-${iconSize}.png`);
    await sharp(normalizedSquarePng).resize(iconSize, iconSize).png().toFile(resizedPngPath);
    pngVariants.push(resizedPngPath);
  }

  const icoBuffer = await pngToIco(pngVariants);
  await fs.writeFile(outputIco, icoBuffer);
  // Keep output quiet and deterministic for script chaining.
  process.stdout.write(`Generated ${outputIco}\n`);
}

main().catch((error) => {
  process.stderr.write(`Icon generation failed: ${error.message}\n`);
  process.exit(1);
});
