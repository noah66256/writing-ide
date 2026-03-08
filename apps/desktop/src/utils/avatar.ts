export async function readImageFileAsDataUrl(file: File, maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (!String(file?.type ?? "").startsWith("image/")) {
    throw new Error("请选择图片文件");
  }
  if (Number(file.size ?? 0) > maxBytes) {
    throw new Error("图片请控制在 4MB 以内");
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        reject(new Error("图片读取失败"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onabort = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}
