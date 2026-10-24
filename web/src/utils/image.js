/**
 * 图片处理工具
 * ---------------------------------------------------------------------------
 * 为什么需要压缩：手机拍的食物照片动辄 3~8MB，
 *   · 直接上传会让请求变慢、占用带宽；
 *   · 多模态模型对分辨率有上限，过大的图反而更贵更慢；
 * 所以在前端用 canvas 把最长边压到 1280px、JPEG 质量 0.85 ——
 * 这个尺寸对「识别食物」完全够用（实测 145KB 的图能准确识别 8 种食材）。
 *
 * 解码策略（顺序尝试，兼容性最好）：
 *   ① createImageBitmap —— 支持格式最多、在主线程外解码，大图不卡界面；
 *   ② 回退到 <img> + dataURL —— 老浏览器没有 createImageBitmap 时用。
 * 两者都失败时，抛出的错误会**带上格式与体积**，界面据此给出可执行的建议
 * （例如 HEIC 在安卓 Chrome 里解不了，必须换 JPG 或直接用「拍照」按钮）。
 */

/** 常见图片扩展名（有些安卓文件选择器给出的 MIME 是空串，只能靠扩展名兜底） */
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i;

/** 是不是 HEIC/HEIF（iPhone 默认格式，多数安卓浏览器解不了） */
export function isHeicFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '');
  return type.includes('heic') || type.includes('heif') || /\.hei[cf]$/i.test(name);
}

/** 是否可能是图片：优先看 MIME，MIME 缺失时看扩展名 */
export function looksLikeImage(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  if (!type || type === 'application/octet-stream') return IMAGE_EXT_RE.test(String(file?.name || ''));
  return false;
}

/** 用 createImageBitmap 解码（失败则回退 <img>） */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* 落到下面的 <img> 方案 */
    }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('浏览器无法解码这张图片'));
    img.onload = () => resolve(img);
    img.src = dataUrl;
  });
}

/**
 * 把 File 压缩成 base64 dataURL
 * @param {File} file 用户选择的图片文件
 * @param {{maxEdge?: number, quality?: number}} opts
 * @returns {Promise<string>} data:image/jpeg;base64,...
 */
export async function compressImage(file, { maxEdge = 1280, quality = 0.85 } = {}) {
  let source;
  try {
    source = await decodeImage(file);
  } catch (err) {
    // 把「为什么失败」说清楚，界面据此引导用户换图或改用拍照
    const kb = Math.round((file?.size || 0) / 1024);
    const kind = isHeicFile(file) ? 'HEIC/HEIF' : file?.type || '未知格式';
    const e = new Error(
      isHeicFile(file)
        ? `这张是 ${kind} 格式（iPhone 默认格式），当前浏览器无法解码。请在相册里选一张 JPG/PNG，或直接点「拍照」拍一张。`
        : `浏览器无法解码这张图片（格式 ${kind}，${kb}KB）。请换一张 JPG/PNG 试试。`,
    );
    e.cause = err;
    e.fileInfo = { name: file?.name, type: file?.type, size: file?.size };
    throw e;
  }

  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  if (!w || !h) throw new Error('这张图片没有有效的尺寸信息，可能已损坏');

  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  // 白底铺垫：透明 PNG 转 JPEG 时避免出现黑底
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === 'function') source.close(); // ImageBitmap 用完即释放

  return canvas.toDataURL('image/jpeg', quality);
}

/** 把 dataURL 的大小换算成可读文本 */
export function dataUrlSize(dataUrl = '') {
  const base64 = String(dataUrl).split(',')[1] || '';
  return Math.round((base64.length * 3) / 4 / 1024); // KB
}
