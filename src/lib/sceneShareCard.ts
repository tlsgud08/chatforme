import { DEFAULT_DARK } from './theme';
import { sceneTurnLabel, type SharedScene } from './sceneShareView.js';

function loadImage(url: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const timeout = window.setTimeout(() => finish(null), 3500);
    function finish(result: HTMLImageElement | null) {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    }
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  context.drawImage(image, (image.naturalWidth - sourceWidth) / 2, (image.naturalHeight - sourceHeight) / 2,
    sourceWidth, sourceHeight, x, y, width, height);
}

function fitLines(context: CanvasRenderingContext2D, title: string, width: number) {
  const lines: string[] = [];
  let line = '';
  for (const character of title.replace(/\s+/g, ' ').trim()) {
    if (context.measureText(line + character).width > width && line) {
      lines.push(line.trimEnd());
      line = character.trimStart();
    } else {
      line += character;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 3) {
    let last = lines[2];
    while (last && context.measureText(last + '…').width > width) last = last.slice(0, -1);
    lines[2] = last + '…';
  }
  return lines.slice(0, 3);
}

export async function buildSceneShareCard(scene: SharedScene): Promise<string | null> {
  const [logo, thumbnail] = await Promise.all([
    loadImage('/logo-128.png'),
    loadImage(scene.thumbnail),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.fillStyle = '#020617';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = DEFAULT_DARK.main;
  context.beginPath();
  context.roundRect(36, 36, 1128, 558, 28);
  context.fill();

  if (thumbnail) {
    context.save();
    context.beginPath();
    context.roundRect(628, 60, 512, 510, 20);
    context.clip();
    drawCover(context, thumbnail, 628, 60, 512, 510);
    context.restore();
  }

  if (logo) context.drawImage(logo, 84, 84, 72, 72);
  const font = 'system-ui, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  context.textBaseline = 'middle';
  context.fillStyle = DEFAULT_DARK.mainText;
  context.font = '650 32px ' + font;
  context.fillText('Inuchat', logo ? 174 : 84, 120);

  context.font = '700 59px ' + font;
  const lines = fitLines(context, scene.title, thumbnail ? 500 : 1008);
  lines.forEach((line, index) => context.fillText(line, 84, 235 + index * 73));

  context.fillStyle = '#c7d2fe';
  context.font = '600 36px ' + font;
  context.fillText(sceneTurnLabel(scene.start, scene.end), 84, 497);
  context.fillStyle = DEFAULT_DARK.accent;
  context.fillRect(84, 539, 60, 4);

  for (const quality of [0.84, 0.72, 0.58]) {
    const encoded = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if (encoded && encoded.length <= 400000) return encoded;
  }
  return null;
}
