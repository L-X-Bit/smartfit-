/**
 * 图片处理工具
 * ---------------------------------------------------------------------------
 * 为什么需要压缩：手机拍的食物照片动辄 3~8MB，
 *   · 直接上传会让请求变慢、占用带宽；
 *   · 多模态模型对分辨率有上限，过大的图反而更贵更慢；
 * 所以在前端用 canvas 把最长边压到 1280px、JPEG 质量 0.82 ——
 * 这个尺寸对「识别食物」完全够用（实测 145KB 的图能准确识别 8 种食材）。
 */

/**
 * 把 File 压缩成 base64 dataURL
 * @param {File} file 用户选择的图片文件
 * @param {{maxEdge?: number, quality?: number}} opts
 * @returns {Promise<string>} data:image/jpeg;base64,...
 */
export function compressImage(file, { maxEdge = 1280, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败，请换一张'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        // 白底铺垫：透明 PNG 转 JPEG 时避免出现黑底
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 把 dataURL 的大小换算成可读文本 */
export function dataUrlSize(dataUrl = '') {
  const base64 = String(dataUrl).split(',')[1] || '';
  return Math.round((base64.length * 3) / 4 / 1024); // KB
}
