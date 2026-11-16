# معماری و جزئیات فنی

## سرور
- Node.js 22، پایگاه داده‌ی SQLite داخلی (`node:sqlite`)، بدون هیچ بسته‌ی npm
- سرویس systemd با کاربر کم‌دسترسی و سقف حافظه
- HTTPS با گواهی خودامضا EC P-256 (۱۰ ساله، SAN برابر IP) که داخل اپ pin شده است
- زمان‌بندی و پشتیبان‌گیری: `VACUUM INTO` و فشرده‌سازی gzip، با نگهداری تعداد مشخص
- امنیت: ufw، fail2ban، unattended-upgrades؛ رمزها با scrypt؛ توکن نشست به‌صورت هش (۹۰ روزه)؛ محدودیت تلاش ورود

## ارتباط زنده
به‌جای WebSocket از SSE (`GET /api/events`) برای دریافت و `POST` برای ارسال استفاده شده است. رویدادها: `msg`، `pin`، `presence`، `profile`، `refresh`، `sig`. سرور هر ۱۵ ثانیه ping می‌فرستد و کلاینت با مهلت ۴۵ ثانیه اتصال مرده را تشخیص می‌دهد؛ پیام‌های از دست‌رفته با `since` بازپخش می‌شوند.

## رمزنگاری
- هر کاربر یک جفت‌کلید EC P-256 دارد؛ کلید خصوصی با کلید AES داخل Android Keystore محافظت می‌شود
- کلید جفتی: ECDH + HKDF-SHA256
- هر پیام یک کلید تصادفی AES-256-GCM دارد که برای هر گیرنده با کلید جفتی او بسته‌بندی می‌شود
- فایل‌ها (نسخه‌ی ۲): تکه‌های ۱ مگابایتی با AES-GCM؛ nonce = ۸ بایت تصادفی + شماره‌ی تکه؛ AAD شامل شماره‌ی تکه و پرچم «آخرین تکه» برای جلوگیری از جابه‌جایی و بریدن فایل
- سیگنالینگ تماس نیز رمزشده و فقط زنده است (ذخیره نمی‌شود)

## مجوزها
- دسته‌ها (categories)، عضویت کاربران، ارتباط کاربران (جدول `visibility`؛ پنل از 1.3 همیشه هر دو جهت را با هم می‌نویسد و `blocks` برای ⛔)
- `canDM` = هدف در فهرست من باشد یا او قبلاً به من پیام داده باشد
- گروه‌ها: کلید `all` برای دسته‌ی ۱ و `g:<id>` برای بقیه

## API (خلاصه)
| مسیر | کار |
|---|---|
| `POST /api/login`, `/api/logout` | ورود و خروج |
| `GET /api/auth/config` | گزینه‌های صفحهٔ ورود: پیامک، رمز، فایل APK |
| `POST /api/auth/sms`, `/api/auth/code` | ورود با شمارهٔ موبایل: کد پیامکی (سرویس‌دهندهٔ انتخابی در پنل، فعلاً آرتا پیامک؛ ۵ رقم، ۲ دقیقه) یا کد دستگاه دیگر / مدیر (۶ رقم)؛ هر کد یک‌بارمصرف، فقط HMAC آن ذخیره می‌شود و با ۳ تلاش اشتباه از بین می‌رود |
| `POST /api/auth/devicecode` | کد ۵ دقیقه‌ای برای ورود دستگاه تازه، روی دستگاهی که وارد است (بدون پیامک و اینترنت) |
| `POST /api/auth/reauth` | کد پیامکی به‌جای رمز ورود برای تغییر پشتیبان کلید |
| `POST /api/auth/signup` | ثبت‌نام آزاد: با بلیت ۱۵ دقیقه‌ای که بعد از کد پیامکی شمارهٔ تازه داده می‌شود، نام کاربری و نام نمایشی |
| `POST /api/contacts/lookup` | تا ۲۰۰۰ شماره → اعضای قابل‌پیدا شدن (شماره‌ها ذخیره نمی‌شوند، سقف روزانه) |
| `GET /api/app/version` | نسخهٔ APK بارگذاری‌شده (`{code, name, size}`، خوانده‌شده از AndroidManifest داخل فایل با `apkinfo.js`) برای پیشنهاد به‌روزرسانی در اپ (۱.۹) |
| `POST /api/password` | تغییر رمز ورود توسط خود کاربر: `{current, password}`؛ `current` رمز فعلی یا کد `reauth` است؛ بقیهٔ نشست‌ها حذف می‌شوند (۱.۹) |
| `GET /download/sepan.apk` | فایل اپ اندروید که مدیر در پنل بارگذاری کرده (عمومی؛ QR آن در `/download/sepan-qr.svg`) |
| `GET /` با دامنه، `/app` | با نام دامنه، صفحهٔ معرفی عمومی (متن از پنل)؛ برنامه در `/app`. با IP، `/` همان برنامه است. گواهی دامنه با `server/domain.sh` (Let's Encrypt، HTTP-01 روی پورت ۸۰، انتخاب با SNI از `certs/le/<name>/`) |
| `GET /api/me`, `/api/users`, `/api/groups` | هویت، مخاطبان مجاز، گروه‌ها |
| `POST /api/profile`, `/api/avatar` | نام نمایشی و عکس (WebP حداکثر ۵۱۲×۵۱۲ و ۴۰۰ کیلوبایت) |
| `GET /api/avatar/<user>` | عکس پروفایل (فقط مخاطبان مجاز) |
| `GET /api/events?since=` | جریان رویدادها (SSE) |
| `POST /api/send` | ارسال پیام یا سیگنال |
| `POST /api/pin` | پین پیام |
| `POST /api/uploads`, `GET/PATCH /api/uploads/<id>` | آپلود تکه‌ای قابل‌ادامه (سرآیند `Upload-Offset`) |
| `GET /api/file/<id>` | دانلود با پشتیبانی از Range |
| `GET /api/turn` | اعتبار موقت TURN (HMAC-SHA1) |

## نسخهٔ وب (PWA)
- `server/src/web.js` یک شنوندهٔ HTTPS جدا روی پورت ۴۴۳ (`WEB_PORT`) با گواهی جدا (`WEB_CERT_DIR`، پیش‌فرض `certs/web`) راه می‌اندازد. مسیرهای `/api/` همان handler پورت ۸۴۴۳ هستند؛ بقیه فایل‌های ثابت `server/src/web/` با CSP سخت‌گیرانه (`script-src 'self'`) است. گواهی هر ساعت دوباره خوانده می‌شود (`setSecureContext`).
- پورت ۸۰ (`WEB_HTTP_PORT`، با `0` خاموش) فقط `/setup`، `/sepan-ca.mobileconfig` (پروفایل iOS از نوع `com.apple.security.root`) و `/sepan-ca.crt` را می‌دهد و بقیه را به https هدایت می‌کند. `WEB_DISABLE=1` کل نسخهٔ وب را خاموش می‌کند.
- کلاینت: ماژول‌های ES بدون build؛ `crypto.mjs` نسخهٔ WebCrypto همان `Crypto.kt` است (کلید عمومی SPKI، HKDF با salt صفر، AES-GCM با IV دوازده‌بایتی در ابتدا، فایل‌های تکه‌ای با nonce و AAD یکسان). کلید خصوصی به‌صورت CryptoKey در IndexedDB می‌ماند و پیام‌های رمزگشایی‌شده و عکس‌ها هم در IndexedDB ذخیره می‌شوند.
- رویدادهای زنده با `fetch` و خواندن جریان SSE (EventSource هدر Authorization نمی‌فرستد).
- عکس پروفایل با یک رمزگذار کوچک WebP بی‌اتلاف (VP8L) در `webp.mjs` ساخته می‌شود، چون Safari از canvas خروجی WebP نمی‌دهد.
- تماس‌ها با WebRTC مرورگر و همان سیگنال‌های رمزشدهٔ `sig_invite/accept/ice/reject/hangup` اپ اندروید.

## تماس گروهی (۱.۱۹)
- مش: هر جفت شرکت‌کننده یک RTCPeerConnection جدا دارد؛ میکروفون یک بار گرفته و به همهٔ اتصال‌ها داده می‌شود. تازه‌وارد به همه offer می‌دهد و قدیمی‌ها answer.
- سرور فقط «اتاق» را در حافظه نگه می‌دارد (`server/src/gcall.js`): چه کسی داخل است، گوشی چه کسانی زنگ می‌خورد (۴۵ ثانیه)، دست بالا، بی‌صدا، و کلید عمومی هر نفر برای رمز کردن سیگنال‌ها. اپی که بیش از ۳۰ ثانیه وصل نباشد از تماس بیرون می‌رود.
- API: `GET /api/gcall` و `POST /api/gcall/{start,join,leave,decline,invite,sig,act,host}`؛ رویدادهای زنده: `gcall`، `gcall_end`، `gsig`، `gcall_react`، `gcall_host`. محتوای `gsig` (SDP و ICE) سرتاسری برای همان یک نفر رمز می‌شود.
- تبدیل تماس دونفره: `sig_upgrade` با شناسهٔ اتاق؛ طرف مقابل تماس دونفره را بی‌صدا می‌بندد و به اتاق می‌پیوندد.
- کد: اندروید `GroupCall.kt` و `GroupCallScreen.kt`، وب `web/groupcall.mjs`.
- ترافیک رله: `server/src/turnlog.js` خطوط `usage` لاگ coturn (`TURN_LOG_FILE`) را می‌خواند و در ستون `turn` جدول `usage_daily` جمع می‌کند.

## گروه‌های کاربران (۱.۲۰)
- در همان جدول `categories` با `kind='user'` و همان کلید `g:<id>`؛ بنابراین ارسال، رسید، پین، تایپ، فایل و تماس گروهی بدون تغییر کار می‌کنند. ستون‌های تازه: `owner`، `about`، `avatar_ver`، `invite`، `admins_only`، `frozen`، `call_on`؛ در `user_categories` ستون‌های `role` (owner/admin/member)، `joined` و `via`؛ جدول `group_bans` برای بیرون‌شده‌ها. در مهاجرت، جدول یک بار بدون UNIQUE(name) بازسازی می‌شود و شمارهٔ دسته‌های حذف‌شده دوباره داده نمی‌شود.
- کد: `server/src/ugroups.js`؛ API: `GET /api/ugroups`، `POST /api/ugroups/create`، `GET|POST /api/ugroups/join/<token>`، `GET /api/ugroups/<id>`، `POST /api/ugroups/<id>/{edit,add,remove,role,transfer,invite,leave,delete}`، `POST|DELETE /api/ugroups/<id>/avatar`، `GET /api/ugroups/<id>/qr`، `GET /api/gavatar/<id>`. پنل: `/admin/api/ugroups…`.
- سقف ساخت (تنظیم `ugroups_limit`، ستون `users.ugroup_limit` برای هر کاربر) فقط گروه‌هایی را می‌شمارد که کاربر الان مالک آن‌هاست.

## کانال‌ها (۱.۲۱)
- ردیف `categories` با `kind='chan'`؛ ستون‌های تازه `ckv` (نسخهٔ فعلی کلید) و `sign`. جدول `chan_keys(category_id, kv, username, wrapped, by_user, by_pub, for_pub)` نسخهٔ قفل‌شدهٔ کلید هر عضو را نگه می‌دارد.
- کلید کانال ۳۲ بایت تصادفی (AES-GCM) است و برای هر عضو با کلید ECDH جفتی قفل می‌شود (AAD: `sepan-ck|<gkey>|<kv>|<member>`). پست: `{v:2, kv, c}` با AAD `<sender>|<target>`. اولین مدیری که نسخهٔ بی‌کلید را بگیرد آن را «ادعا» می‌کند و برای همه قفل می‌کند؛ بعد هر مدیر برای اعضای بی‌کلید (`pending`) قفل می‌کند. بیرون کردن عضو `ckv` را یکی بالا می‌برد؛ ارسال با نسخهٔ قدیمی `409 chan_key_old` می‌گیرد.
- API: `GET|POST /api/ugroups/<id>/keys`، `GET /api/ugroups/<id>/views` (فهرست بی‌نام آخرین پیام دیدهٔ هر عضو)، `GET /api/ugroups/<id>/posts?before=` (۱۰۰ تایی). رسیدها فقط به دستگاه‌های خود خواننده می‌روند؛ واکنش‌ها برای غیرمدیر با HMAC بی‌نام می‌شوند؛ تایپ و تماس در کانال نیست؛ اعضای کانال «هم‌گروه» حساب نمی‌شوند.
- تنظیمات: `chans_on` (پیش‌فرض خاموش)، `chans_max_members` (پیش‌فرض ۱۰۰۰).

## پنل مدیریت
پورت جدا (۸۴۴۴)، رابط فارسی راست‌به‌چپ، CSRF، کوکی HttpOnly/SameSite=Strict/Secure، سیاست CSP سخت‌گیرانه، محدودیت تلاش ورود (۵ شکست برای هر IP ← ۱۰ دقیقه مسدودی)، و `ufw limit 8444/tcp`.

## اپ اندروید
- Kotlin و Jetpack Compose، بسته‌ی `com.pchat.app`
- سرویس پیش‌زمینه برای اتصال همیشه روشن (بدون FCM)، با WakeLock و WifiLock و اتصال مجدد فوری هنگام تغییر شبکه
- ذخیره‌ی محلی پیام‌ها در SQLite با ارتقای خودکار ساختار
- صف ارسال: پیام‌ها ابتدا محلی ذخیره می‌شوند و تا موفقیت دوباره تلاش می‌شود؛ آپلود فایل از آخرین آفست سرور ادامه پیدا می‌کند
- دانلود فایل بزرگ با Range و رمزگشایی تکه‌به‌تکه، بدون بارکردن کل فایل در حافظه
