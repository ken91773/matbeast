import fs from "node:fs/promises";
import path from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const webRoot = process.cwd();
/** Default: repo root `matbeastlogo.png` (parent of `web/`). Override: set MATBEAST_LOGO_PNG to an absolute or cwd-relative PNG path. */
const sourcePng = process.env.MATBEAST_LOGO_PNG?.trim()
  ? path.resolve(webRoot, process.env.MATBEAST_LOGO_PNG)
  : path.resolve(webRoot, "..", "matbeastlogo.png");
const buildDir = path.resolve(webRoot, "build");
const outputIco = path.resolve(buildDir, "icon.ico");
const normalizedSquarePng = path.resolve(buildDir, "icon-square.png");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  process.stdout.write(`[generate-icon] Reading logo from: ${sourcePng}\n`);
  await fs.access(sourcePng);
  await fs.mkdir(buildDir, { recursive: true });

  const image = sharp(sourcePng, { failOn: "none" });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unable to read image dimensions from matbeastlogo.png");
  }

  /**
   * The repo logo is 180×203 (portrait). A center-cover crop chops the fang tips off
   * the top and the "MAT BEAST" text off the bottom, which is very visible on the
   * desktop shortcut and Start Menu. Letterbox into a transparent square using the
   * larger dimension so the whole logo is preserved at every ICO size.
   */
  const size = Math.max(metadata.width, metadata.height);
  await image
    .resize(size, size, {
      fit: "contain",
      position: "center",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
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
