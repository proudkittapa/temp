// Slip photos are checked and, when large, shrunk in the browser before
// upload: the server takes JPG/PNG/WebP up to 5 MB, and a phone camera
// photo can be bigger or HEIC. Small JPG/PNG/WebP files (e.g. banking-app
// screenshots) are sent unchanged, so the server's duplicate-slip check
// still sees the original bytes.
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 1600; // px - bank slip text stays readable

export class SlipImageError extends Error {}

export async function prepareSlipImage(file: File): Promise<File> {
  if (ACCEPTED.includes(file.type) && file.size <= KEEP_AS_IS_BYTES) return file;
  if (!file.type.startsWith('image/')) throw new SlipImageError('ไฟล์นี้ไม่ใช่รูปภาพ กรุณาเลือกรูปสลิป (JPG หรือ PNG)');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new SlipImageError('เปิดรูปนี้ไม่ได้ กรุณาใช้ภาพหน้าจอสลิปแบบ JPG หรือ PNG');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new SlipImageError('ย่อรูปไม่สำเร็จ กรุณาใช้ภาพหน้าจอสลิปแบบ JPG หรือ PNG');
  if (blob.size > MAX_BYTES) throw new SlipImageError('รูปใหญ่เกิน 5 MB กรุณาใช้ภาพหน้าจอสลิป');
  return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
}
