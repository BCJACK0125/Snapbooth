# 📷 Snapbooth 拍照亭

免安裝、免註冊的**網頁拍照亭 + 線上修圖器**。用筆電（或手機）鏡頭拍照，立即裁切、調色、加文字、塗鴉、消除路人，還能把照片裡的文字轉成可複製的內容。

> **所有處理都在使用者的瀏覽器完成，照片不會上傳到任何伺服器。**
> 純靜態網站，無需後端、無需建置，直接部署到 GitHub Pages。

## ✨ 功能

### 拍照
- 筆電／外接鏡頭拍照，可切換多顆鏡頭、選擇解析度（自動 / 720p / 1080p / 4K）
- **水平翻轉**（預覽與成品一致，拍完後也能單張再翻轉）
- 倒數計時（3 / 5 / 10 秒）、三分格參考線、快門音效、拍攝濾鏡
- 完整的權限／錯誤提示（拒絕權限、找不到鏡頭、鏡頭被占用、中途斷線）
- 也能**匯入圖片**或把檔案**拖進頁面**編輯（沒有鏡頭也能使用）

### 編輯器
| 工具 | 內容 |
| --- | --- |
| 🎚 調整 | 亮度、對比、飽和度、色溫、復古、暈影；8 種附即時縮圖的一鍵濾鏡；按住可對照原圖 |
| ✂️ 裁切 | 自由 / 1:1 / 4:3 / 3:4 / 16:9 / 9:16 / 3:2 / 2:3；旋轉 90°、水平／垂直翻轉 |
| 🅣 文字 | 多行文字、5 種字型、大小、旋轉、顏色、粗體、描邊、陰影、表情符號貼圖，可拖曳定位 |
| 🖍 塗鴉 | 畫筆、螢光筆、直線、箭頭、方框、橢圓、**馬賽克**（遮蔽隱私），可調顏色／粗細／透明度 |
| ✨ 橡皮擦 | **消除物件**（塗抹後自動以周圍像素填補）、**魔術去背**（點選顏色變透明，可調容許度與邊緣柔化） |
| 🖼 相框 | 白框、黑框、拍立得、圓角 |
| 🔎 辨識文字 | **OCR**：繁中 / 簡中 / 英 / 日 / 韓，結果可編輯、複製、下載 .txt，並在圖上標示文字框 |

通用：無限次復原／重做（`Ctrl/⌘+Z`、`Ctrl/⌘+Shift+Z`）、縮放（`Ctrl/⌘+滾輪`）、還原原圖、匯出對話框（PNG / JPEG / WebP、品質、尺寸 100–25%、預估檔案大小、複製到剪貼簿、系統分享）。

### 快捷鍵
| 位置 | 按鍵 | 動作 |
| --- | --- | --- |
| 相機 | `空白鍵` | 拍照（倒數中再按一次可取消） |
| 相機 | `M` / `G` | 水平翻轉 / 參考線 |
| 編輯器 | `Ctrl/⌘+Z` | 復原 |
| 編輯器 | `Ctrl/⌘+Shift+Z`、`Ctrl+Y` | 重做 |
| 編輯器 | `Esc` | 取消編輯 |

## 🚀 部署到 GitHub Pages

1. 在 GitHub 建立新的儲存庫（例如 `snapbooth`），把本專案所有檔案放在儲存庫**根目錄**：
   ```
   index.html
   css/styles.css
   js/app.js
   js/editor.js
   js/inpaint.js
   README.md
   ```
2. 到儲存庫的 **Settings → Pages**。
3. **Source** 選 *Deploy from a branch*，**Branch** 選 `main`、資料夾選 `/ (root)`，按 **Save**。
4. 等待 1–2 分鐘，網站會出現在 `https://<你的帳號>.github.io/<儲存庫名>/`。

> 相機功能需要 **HTTPS**（或 `localhost`）。GitHub Pages 預設就是 HTTPS，不需額外設定。

### 命令列版本
```bash
git init && git add . && git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<帳號>/<儲存庫>.git
git push -u origin main
```
然後依上面的步驟 2–3 開啟 Pages。

## 💻 本機測試

不能直接用 `file://` 開啟（瀏覽器會封鎖相機），請啟動一個本機伺服器：
```bash
# Python
python3 -m http.server 8000
# 或 Node
npx serve .
```
開啟 <http://localhost:8000>。

## 🧠 技術說明

- **純靜態**：HTML + CSS + 原生 JavaScript（無框架、無建置步驟），三個腳本檔以全域命名空間 `window.PB` 協作。
- **相機**：`getUserMedia` + `<canvas>`。
- **影像處理**：Canvas 2D；調整、馬賽克、去背、修補都在 CPU 上以 `Uint8ClampedArray` 逐像素運算，繪圖本身由瀏覽器的 Canvas（多數環境為 GPU 加速）處理。
- **魔術橡皮擦（物件消除）**：自行實作的 *push-pull* 金字塔修補 → 洞內 Gauss-Seidel 平滑 → 依周邊顆粒量測補償噪點，避免填補處過於平滑。**不需要下載任何模型。** 適合小物件、污點、路人與單純背景；大面積或複雜紋理會留下模糊痕跡，建議分次小範圍塗抹。
- **魔術去背**：點選像素後以容許度做洪水填充（或全圖比對），並以盒狀模糊產生柔化邊緣。
- **OCR**：[Tesseract.js](https://github.com/naptha/tesseract.js)（固定使用 v5.1.1），於使用者的 CPU 以 WebAssembly 執行；**僅在使用者按下「開始辨識」時才從 jsDelivr 載入**，語言資料由瀏覽器快取。圖片不會上傳。
- **隱私**：沒有任何分析、追蹤或後端請求；設定（鏡頭解析度、格式等）只存在 `localStorage`。

### 關於 GPU
目前沒有使用 WebGPU／WebGL 推論。若需要更高品質的「生成式」物件消除或自動去背（例如 LaMa、U²-Net），可再整合 ONNX Runtime Web（WebGPU 後端），但模型檔通常為數十到上百 MB，會明顯增加首次載入成本，因此預設版本選擇純演算法方案。

### 自行託管 OCR 引擎（離線／內網）
預設從 CDN 載入。若想自行託管，把 `tesseract.min.js`、`worker.min.js`、`tesseract-core` 與語言檔（`*.traineddata.gz`）放到專案內，並在 `js/app.js` 載入前設定：
```html
<script>
  window.PB = { config: {
    tesseractSrc: 'vendor/tesseract.min.js',
    tesseractOptions: { workerPath: 'vendor/worker.min.js', corePath: 'vendor/core/', langPath: 'vendor/lang' }
  } };
</script>
<script src="js/inpaint.js" defer></script>
```
（參數細節請參考 [Tesseract.js 文件](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)。）

## 🌐 瀏覽器支援

最新版 Chrome、Edge、Firefox、Safari。
- 不支援 `CanvasRenderingContext2D.filter` 的瀏覽器（例如部分 Safari）會自動改用逐像素濾鏡。
- 匯入 HEIC 等瀏覽器無法解碼的格式時會顯示提示。
- 超過 4096 px 的匯入圖片會自動縮小（可用 `PB.config.maxImportSize` 調整），避免行動裝置記憶體不足。

## 🛠 客製化

- **品牌**：修改 `index.html` 中的 `.brand`、標題與文案；主色定義在 `css/styles.css` 最上方的 CSS 變數（`--brand`、`--brand2`、`--grad`）。
- **濾鏡預設**：`js/editor.js` 的 `Tools.adjust` → `PRESETS`。
- **字型**：`js/editor.js` 的 `Tools.text` → `FONTS`（預設只用系統字型，避免外部字型請求）。
- **OCR 語言**：`js/editor.js` 的 `Tools.ocr` → `LANGS`（語言代碼見 Tesseract 文件）。

## ❓ 疑難排解

| 問題 | 解法 |
| --- | --- |
| 沒有跳出相機權限視窗 | 確認網址是 `https://` 或 `localhost`；點網址列左側鎖頭圖示重新允許相機 |
| 「相機被占用」 | 關閉視訊會議等正在使用鏡頭的程式後重試 |
| OCR 一直停在載入 | 檢查是否能連到 `cdn.jsdelivr.net` 與語言資料來源；首次下載中文資料較大，請耐心等候 |
| 消除後有模糊痕跡 | 縮小標記範圍、分次塗抹；背景越單純效果越好 |
| 下載的 JPEG 透明處變白 | JPEG 不支援透明，請改用 PNG 或 WebP |

## 🗺 路線圖（想法）

- 連拍拼貼（Photo strip）與列印版型
- 貼紙／浮水印圖層（可重新編輯的物件式文字）
- WebGPU 本機模型：自動去背、生成式物件消除
- PWA（可安裝、離線使用）

## 📄 授權

建議使用 MIT License。請依你的需求新增 `LICENSE` 檔。第三方元件：Tesseract.js（Apache-2.0）。
