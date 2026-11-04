# 📷 Snapbooth 拍照亭

免安裝、免註冊的**網頁拍照亭 + 線上修圖器**。用筆電（或手機）鏡頭拍照，立即裁切、調色、加文字、塗鴉；還有 **AI 物件消除、AI 一鍵去背、進階文字辨識**，全部在瀏覽器裡完成。

> **照片不會上傳到任何伺服器。** 純靜態網站，無需後端、無需建置，直接部署到 GitHub Pages。
> AI 模型只在使用者按下功能時才**動態下載**（並快取），沒用到就不會載入。

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
| ✨ 橡皮擦 | **消除物件**：快速（內建演算法）／ **AI 標準 MI-GAN** ／ **AI 高品質 LaMa**；**自動選取主體**（U²-Net-P / BiRefNet-lite）後一鍵移除並補背景；**去背**：AI 自動或點選顏色 |
| 🖼 相框 | 白框、黑框、拍立得、圓角 |
| 🔎 辨識文字 | **標準**：Tesseract（繁中 / 簡中 / 英 / 日 / 韓）；**進階**：PaddleOCR PP-OCRv5（中・英・日通用、拉丁語系，支援直排與傾斜文字）。結果可編輯、複製、下載 .txt，並在圖上標示文字框 |

通用：無限次復原／重做、縮放（`Ctrl/⌘+滾輪`）、還原原圖、匯出對話框（PNG / JPEG / WebP、品質、尺寸 100–25%、預估檔案大小、複製到剪貼簿、系統分享）。頁尾的「管理已下載的 AI 模型」可查看並刪除已快取的模型。

### 快捷鍵
| 位置 | 按鍵 | 動作 |
| --- | --- | --- |
| 相機 | `空白鍵` | 拍照（倒數中再按一次可取消） |
| 相機 | `M` / `G` | 水平翻轉 / 參考線 |
| 編輯器 | `Ctrl/⌘+Z` | 復原 |
| 編輯器 | `Ctrl/⌘+Shift+Z`、`Ctrl+Y` | 重做 |
| 編輯器 | `Esc` | 取消編輯 |

## 🧠 AI 進階功能

所有模型都以 [ONNX Runtime Web](https://onnxruntime.ai/) 在使用者的裝置上執行：**優先 WebGPU，不支援時自動改用 WASM（CPU）**。第一次使用某個功能才下載模型（有進度條、可取消），之後存進瀏覽器的 Cache Storage，不會重複下載。

| 功能 | 模型 | 下載大小 | 授權 | 來源 |
| --- | --- | --- | --- | --- |
| 物件消除（標準） | MI-GAN | 28 MB | MIT | [edgetools/migan](https://huggingface.co/edgetools/migan) |
| 物件消除（高品質） | LaMa | 208 MB | Apache-2.0 | [Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX) |
| 主體偵測／去背（快速） | U²-Net-P | 4.6 MB | Apache-2.0 | [BritishWerewolf/U-2-Netp](https://huggingface.co/BritishWerewolf/U-2-Netp) |
| 主體偵測／去背（高品質） | BiRefNet-lite | 115 MB（fp16，需 WebGPU）／224 MB（fp32，CPU） | MIT | [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) |
| 進階文字辨識 | PP-OCRv5 mobile（偵測＋辨識） | 21 MB（通用）／13 MB（拉丁） | Apache-2.0 | [nakamura196/ppocrv5-mobile-web-onnx](https://huggingface.co/nakamura196/ppocrv5-mobile-web-onnx) |

> 沒有採用 RMBG-1.4 / 2.0：它們的授權不允許商用。

### 運作方式（為什麼選這個組合）
- **U-Net 系列偵測 + LaMa / MI-GAN 修補**：先用 U²-Net-P 或 BiRefNet 偵測主體，再把遮罩交給修補模型補背景，即「一鍵移除主體」。也可以用筆刷自己塗抹。
- **只貼回「洞」**：推論只針對標記區域周圍的 ROI（LaMa 固定 512×512，MI-GAN 最長邊 ≤ 1024），完成後只替換遮罩範圍並羽化邊緣，**其餘像素與原圖逐位元相同**，大圖也不會整張被重新取樣。
- **自我檢查**：執行時讀取模型的輸入／輸出名稱；偵測輸出數值範圍（0..1 或 0..255）；若模型保留的已知區域與輸入差異過大，會自動以相反的遮罩極性重跑；fp16 模型若拒絕 float32 輸入，會自動改送 float16。
- **WebGPU → WASM 自動退回**：模型初始化或第一次推論失敗時，會改用 WASM 重試（fp16 的 BiRefNet 只能在 WebGPU 執行，沒有 WebGPU 時自動改用 fp32 版）。
- **PP-OCRv5 純 JS 管線**（不依賴 OpenCV）：DB 偵測後處理（二值化 → 連通區塊 → 最小外接矩形 → unclip）→ 旋轉文字框裁切（直排自動轉正）→ CTC 解碼 → 依閱讀順序輸出。

### 效能與限制
- **WebGPU 與 CPU**：有 WebGPU（新版 Chrome / Edge）速度明顯較快；CPU 模式下 LaMa、BiRefNet 可能需要十幾秒到數十秒。GitHub Pages 無法設定 COOP/COEP 標頭，因此 WASM 以單執行緒執行（如需多執行緒，可在自己的伺服器加上這兩個標頭，或使用 `coi-serviceworker`）。
- **LaMa 輸入固定 512×512**：標記範圍遠大於 512 px 時，會縮小處理後再放大貼回，細節會變柔和，建議分次處理。
- **記憶體**：行動裝置請優先使用 MI-GAN 與 U²-Net-P；同時最多保留 3 個已載入的模型，其餘自動釋放。
- **OCR**：韓文請使用「標準」引擎（PP-OCRv5 的韓文模型不在目前使用的模型庫內）。

### 自行託管模型／執行環境（離線、內網、避免第三方 CDN）
把檔案放進專案（例如 `vendor/`），並在 `js/app.js` 之前設定（`index.html` 的 `<script src="js/inpaint.js">` 之前）：

```html
<script>
  window.PB = { config: {
    // ONNX Runtime Web：資料夾需包含 ort.webgpu.min.js、ort.min.js 與對應的 .wasm / .mjs
    ort: { base: 'vendor/ort/' },
    // 逐一覆寫模型網址（id 見 js/ai.js 的 MODELS）
    models: {
      migan: 'vendor/models/migan_pipeline_v2.onnx',
      lama: 'vendor/models/lama_fp32.onnx',
      u2netp: 'vendor/models/u2netp.onnx',
      birefnet: 'vendor/models/birefnet_lite_fp16.onnx',
      birefnet32: 'vendor/models/birefnet_lite.onnx',
      ppocr_det: 'vendor/models/PP-OCRv5_mobile_det.onnx',
      ppocr_rec: 'vendor/models/PP-OCRv5_mobile_rec.onnx',
      ppocr_dict: 'vendor/models/PP-OCRv5_mobile_rec.dict.json'
    },
    // Tesseract（標準 OCR）
    tesseractSrc: 'vendor/tesseract.min.js',
    tesseractOptions: { workerPath: 'vendor/worker.min.js', corePath: 'vendor/core/', langPath: 'vendor/lang' }
  } };
</script>
```
> GitHub 單檔上限 100 MB，LaMa（208 MB）需使用 Git LFS 或放在別的儲存空間（並確認該網址有 CORS）。

## 🚀 部署到 GitHub Pages

1. 在 GitHub 建立新的儲存庫（例如 `snapbooth`），把本專案所有檔案放在儲存庫**根目錄**：
   ```
   index.html
   css/styles.css
   js/app.js
   js/ai.js
   js/editor.js
   js/inpaint.js
   README.md
   ```
2. 到儲存庫的 **Settings → Pages**。
3. **Source** 選 *Deploy from a branch*，**Branch** 選 `main`、資料夾選 `/ (root)`，按 **Save**。
4. 等待 1–2 分鐘，網站會出現在 `https://<你的帳號>.github.io/<儲存庫名>/`。

> 相機與模型快取都需要 **HTTPS**（或 `localhost`）。GitHub Pages 預設就是 HTTPS，不需額外設定。

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
python3 -m http.server 8000   # 或 npx serve .
```
開啟 <http://localhost:8000>。

### ✅ 部署後請先自己驗證一次 AI 功能
AI 管線的邏輯（裁切貼回、極性自我修正、fp16 重試、DB 後處理、CTC 解碼、快取、取消下載）已用**模擬的 ONNX Runtime** 在無頭 Chrome 中測試；但**真實模型的推論結果需要你在有網路的瀏覽器中確認**：

1. 匯入一張有雜物的照片 → 橡皮擦 → 引擎選「AI 標準・MI-GAN」→ 塗抹雜物 → 執行消除。
2. 再選「AI 高品質・LaMa」重做一次，比較結果。
3. 去背 → 「AI 自動」→ U²-Net-P、BiRefNet-lite 各試一次。
4. 辨識文字 → 「進階」→ 用一張含中文的截圖測試。
5. 若某個模型失敗，畫面會顯示原因；開啟瀏覽器開發者工具的 Console / Network 分頁可看到詳細錯誤（常見是模型網址被擋或 CORS）。

## 🧠 技術說明

- **純靜態**：HTML + CSS + 原生 JavaScript（無框架、無建置步驟），四個腳本檔以全域命名空間 `window.PB` 協作：`inpaint.js`（內建演算法）、`app.js`（相機／相簿／匯出）、`ai.js`（AI 模型）、`editor.js`（編輯器）。
- **相機**：`getUserMedia` + `<canvas>`。
- **內建修補（快速）**：push-pull 金字塔 → 洞內 Gauss-Seidel 平滑 → 噪點補償，免下載、適合小污點與單純背景。
- **魔術去背（顏色）**：洪水填充（或全圖比對）+ 盒狀模糊邊緣柔化。
- **標準 OCR**：[Tesseract.js](https://github.com/naptha/tesseract.js) v5.1.1，僅在使用者按下辨識時從 jsDelivr 載入。
- **隱私**：沒有任何分析、追蹤或後端請求。連網只發生在：下載 ONNX Runtime（jsDelivr）、模型檔（Hugging Face）、Tesseract 與其語言資料。設定只存在 `localStorage`，模型存在 Cache Storage。

## 🌐 瀏覽器支援

最新版 Chrome、Edge、Firefox、Safari。
- WebGPU 目前以 Chrome / Edge 最完整；其他瀏覽器自動使用 CPU（WASM）。
- 不支援 `CanvasRenderingContext2D.filter` 的瀏覽器（例如部分 Safari）會自動改用逐像素濾鏡。
- 匯入 HEIC 等瀏覽器無法解碼的格式時會顯示提示。
- 超過 4096 px 的匯入圖片會自動縮小（可用 `PB.config.maxImportSize` 調整）。

## 🛠 客製化

- **品牌**：修改 `index.html` 中的 `.brand`、標題與文案；主色定義在 `css/styles.css` 最上方的 CSS 變數（`--brand`、`--brand2`、`--grad`）。
- **模型清單／網址**：`js/ai.js` 的 `MODELS`。
- **濾鏡預設**：`js/editor.js` 的 `Tools.adjust` → `PRESETS`。
- **字型**：`js/editor.js` 的 `Tools.text` → `FONTS`（預設只用系統字型，避免外部字型請求）。
- **OCR 偵測參數**：`PB.ai.ocr(canvas, { thresh, boxThresh, unclip })`（預設 0.3 / 0.6 / 1.5）。

## ❓ 疑難排解

| 問題 | 解法 |
| --- | --- |
| 沒有跳出相機權限視窗 | 確認網址是 `https://` 或 `localhost`；點網址列左側鎖頭圖示重新允許相機 |
| 「相機被占用」 | 關閉視訊會議等正在使用鏡頭的程式後重試 |
| AI 下載失敗 | 確認網路能連到 `cdn.jsdelivr.net` 與 `huggingface.co`；公司網路可能擋下，可改為自行託管 |
| AI 推論很慢 | 換成較小的模型（MI-GAN、U²-Net-P），或使用支援 WebGPU 的 Chrome / Edge |
| 瀏覽器記憶體不足／分頁當掉 | 關閉其他分頁、改用較小的模型；超大圖片請先縮小 |
| 消除後有模糊痕跡 | 縮小標記範圍、分次塗抹；背景越單純效果越好；試試 LaMa |
| 去背邊緣有殘留 | 改用 BiRefNet-lite；或先「復原」後調整再試 |
| 下載的 JPEG 透明處變白 | JPEG 不支援透明，請改用 PNG 或 WebP |
| 想釋放儲存空間 | 頁尾「管理已下載的 AI 模型」→ 刪除 |

## 🗺 路線圖（想法）

- 點選任意物件即自動選取（SAM 類互動式分割）
- 連拍拼貼（Photo strip）與列印版型
- 貼紙／浮水印圖層（可重新編輯的物件式文字）
- PWA（可安裝、離線使用）
- PP-OCRv5 韓文模型

## 📄 授權

MIT License。第三方元件與模型：Tesseract.js（Apache-2.0）、ONNX Runtime Web（MIT）、MI-GAN（MIT）、LaMa（Apache-2.0）、U²-Net（Apache-2.0）、BiRefNet（MIT）、PP-OCRv5（Apache-2.0）。散布時請保留各專案的授權聲明。
