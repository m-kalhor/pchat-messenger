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

android {
    namespace = "com.pchat.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pchat.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 18
        versionName = "1.12.0"

        buildConfigField("String", "SERVER_HOST", "\"$serverHost\"")
        buildConfigField("int", "SERVER_PORT", "$serverPort")
    }

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
