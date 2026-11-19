import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Server address: -P flag > local.properties > gradle.properties.
val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun serverProp(name: String): String =
    (findProperty(name) as String?)?.takeIf { it.isNotBlank() }
        ?: localProps.getProperty(name)?.takeIf { it.isNotBlank() }
        ?: error("Missing Gradle property '$name' (set it in gradle.properties or local.properties)")

val serverHost = serverProp("pchat.serverHost")
val serverPort = serverProp("pchat.serverPort").toIntOrNull()
    ?: error("pchat.serverPort must be a number")

// One fixed signing key, so every new APK installs over the previous one. CI decodes it from the
// SEPAN_KEYSTORE_B64 secret; without it (local builds) the usual per-machine debug key is used.
val sepanKeystore = System.getenv("SEPAN_KEYSTORE")?.let { file(it) }?.takeIf { it.isFile }

// 1.25: an app for another customer's server (built by the "Customer APK" workflow from the installer's build code):
//   -Ppchat.appName=NAME   name under the icon and inside the app (default «سپن»)
//   -Ppchat.appId=ID       package com.pchat.app.ID, so several customers' apps can sit side by side on one phone
//   -Ppchat.iconPng=FILE   own launcher icon (a square PNG), else the Sepan icon
// The server certificate the app pins is res/raw/server_cert.pem (the workflow puts the customer's there).
fun optProp(name: String): String? = (findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: localProps.getProperty(name)?.takeIf { it.isNotBlank() }
val appName = optProp("pchat.appName") ?: "سپن"
val appIdSuffix = optProp("pchat.appId")?.also { require(Regex("^[a-z][a-z0-9]{1,19}$").matches(it)) { "pchat.appId: 2-20 of a-z, 0-9" } }
val iconPng = optProp("pchat.iconPng")?.let { file(it) }?.also { require(it.isFile) { "pchat.iconPng not found: $it" } }
val iconRes: File = layout.buildDirectory.dir("generated/iconres").get().asFile
val copyIcon by tasks.registering(Copy::class) {
    if (iconPng != null) from(iconPng) { rename { "ic_launcher_custom.png" } }
    into(File(iconRes, "drawable-nodpi"))
}
fun kotlinString(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$") + "\""

android {
    namespace = "com.pchat.app"
    compileSdk = 35

    defaultConfig {
        applicationId = if (appIdSuffix != null) "com.pchat.app.$appIdSuffix" else "com.pchat.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 33
        versionName = "1.27.0"

        buildConfigField("String", "SERVER_HOST", "\"$serverHost\"")
        buildConfigField("int", "SERVER_PORT", "$serverPort")
        buildConfigField("String", "APP_NAME", kotlinString(appName))
        manifestPlaceholders["appLabel"] = appName
        manifestPlaceholders["appIcon"] = if (iconPng != null) "@drawable/ic_launcher_custom" else "@mipmap/ic_launcher"
        manifestPlaceholders["appIconRound"] = if (iconPng != null) "@drawable/ic_launcher_custom" else "@mipmap/ic_launcher_round"
    }

    sourceSets["main"].res.srcDir(iconRes)

    signingConfigs {
        if (sepanKeystore != null) create("sepan") {
            storeFile = sepanKeystore
            storePassword = System.getenv("SEPAN_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("SEPAN_KEY_ALIAS") ?: "sepan"
            keyPassword = System.getenv("SEPAN_KEYSTORE_PASSWORD")
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        debug {
            if (sepanKeystore != null) signingConfig = signingConfigs.getByName("sepan")
        }
        // The APK users install is the release build: not debuggable, so Play Protect treats it as a
        // normal app. Same fixed key as before, so it installs over the earlier debug builds.
        // Without the key (local builds) it falls back to the per-machine debug key so it still installs.
        release {
            signingConfig = if (sepanKeystore != null) signingConfigs.getByName("sepan")
                else signingConfigs.getByName("debug")
            isDebuggable = false
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

tasks.named("preBuild") { dependsOn(copyIcon) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.webrtc)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
