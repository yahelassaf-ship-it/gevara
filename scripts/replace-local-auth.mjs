import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../public/index.html", import.meta.url);
const source = await readFile(file, "utf8");
const start = source.indexOf("// ===================== AUTH / USER MANAGEMENT SYSTEM =====================");
const end = source.indexOf("// ===================== END AUTH =====================");

if (start < 0 || end < 0) throw new Error("تعذر العثور على طبقة الحسابات المحلية داخل index.html");

const replacement = `// ===================== SERVER-ONLY AUTH =====================
// الوصول محمي حصراً بمصادقة HTTP Basic الخاصة بالخادم. لا توجد حسابات أو أدوار محلية.
var AUTH = { currentUser: { username: 'server', fullName: 'مستخدم الخادم' } };
function applyAuthUI(){
  var overlay = document.getElementById('login-overlay'); if(overlay) overlay.remove();
  var badge = document.getElementById('user-badge'); if(badge) badge.style.display='none';
  var manage = document.getElementById('user-badge-manage'); if(manage) manage.remove();
  var usersModal = document.getElementById('users-modal'); if(usersModal) usersModal.remove();
  document.body.classList.remove('viewer-mode');
}
function doLogout(){ location.reload(); }
document.addEventListener('DOMContentLoaded', applyAuthUI);
// ===================== END AUTH =====================`;

let updated = source.slice(0, start) + replacement + source.slice(end + "// ===================== END AUTH =====================".length);
if (!updated.includes('/sync-v2.js')) updated = updated.replace("</body>", "<script src=\"/sync-v2.js\"></script>\n</body>");
await writeFile(file, updated, "utf8");
