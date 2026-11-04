# ساخت اپ اندروید

این پوشه یک پروژه‌ی کامل Gradle است (Kotlin، Jetpack Compose، فارسی و راست‌به‌چپ).

## ساخت
1. آدرس سرور را در `gradle.properties` تنظیم کنید (`pchat.serverHost` و `pchat.serverPort`).
   برای تغییر محلی بدون commit، همین کلیدها را در `local.properties` بنویسید؛ یا موقع ساخت `-Ppchat.serverHost=...` بدهید.
2. گواهی سرور باید در `app/src/main/res/raw/server_cert.pem` باشد.
3. پوشه‌ی `android/` را در Android Studio باز کنید، یا:
   ```bash
   ./gradlew assembleRelease
   ```
   خروجی: `app/build/outputs/apk/release/app-release.apk`

پیش‌نیاز: JDK 17 و Android SDK (API 35). حداقل نسخه‌ی اندروید: 8.0 (API 26).

نکته: سرور باید به نسخه‌ی جدید (`server/install.sh` فعلی) ارتقا یافته باشد؛ این کار انجام شده است.

## ساختار
| مسیر | محتوا |
|---|---|
| `app/src/main/java/com/pchat/app/` | کد Kotlin اپ |
| `app/src/main/AndroidManifest.xml` | مانیفست |
| `app/src/main/res/` | آیکون، گواهی سرور و تنظیمات FileProvider |
| `gradle/libs.versions.toml` | نسخه‌ی همه‌ی کتابخانه‌ها |

آدرس سرور از طریق `BuildConfig.SERVER_HOST` و `BuildConfig.SERVER_PORT` به `Config.kt` می‌رسد.
