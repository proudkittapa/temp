// "บันทึกรูป QR": the PromptPay QR as a PNG, with the amount and booking
// code under it, so a customer paying from the same phone can open it from
// the photo gallery in their bank app (bank apps scan a QR from an image).
// Phones get the share sheet ("Save image"); computers a download.

const W = 600;
const QR = 480;

function loadSvg(svg: SVGSVGElement): Promise<HTMLImageElement> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(QR));
  copy.setAttribute('height', String(QR));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('QR image')); };
    img.src = url;
  });
}

export async function qrPngBlob(svg: SVGSVGElement, lines: string[]): Promise<Blob> {
  const img = await loadSvg(svg);
  const lineH = 44;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 60 + QR + 30 + lines.length * lineH + 30;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, (W - QR) / 2, 60, QR, QR);
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  lines.forEach((text, i) => {
    ctx.font = `${i === 0 ? 'bold 34px' : '26px'} sans-serif`;
    ctx.fillText(text, W / 2, 60 + QR + 30 + (i + 1) * lineH - 10);
  });
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

export async function saveQrImage(svg: SVGSVGElement, fileName: string, lines: string[]): Promise<void> {
  const blob = await qrPngBlob(svg, lines);
  const file = new File([blob], fileName, { type: 'image/png' });
  const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // closed the share sheet
      // otherwise fall back to a download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
