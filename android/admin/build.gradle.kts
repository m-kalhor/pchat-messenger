import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// «سپن مدیر» (1.24): the admin panel (port 8444) in a small app that signs in with the phone's fingerprint /
// screen lock after a one-time pairing. Same server address and pinned certificate as the Sepan app.
val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun serverProp(name: String, def: String? = null): String =
    (findProperty(name) as String?)?.takeIf { it.isNotBlank() }
        ?: localProps.getProperty(name)?.takeIf { it.isNotBlank() }
        ?: def
        ?: error("Missing Gradle property '$name' (set it in gradle.properties or local.properties)")

val serverHost = serverProp("pchat.serverHost")
val adminPort = serverProp("pchat.adminPort", "8444").toIntOrNull() ?: error("pchat.adminPort must be a number")
val sepanKeystore = System.getenv("SEPAN_KEYSTORE")?.let { file(it) }?.takeIf { it.isFile }

// the server certificate is pinned exactly like in the Sepan app: one copy, taken from the app module
val certRes: File = layout.buildDirectory.dir("generated/certres").get().asFile
val copyServerCert by tasks.registering(Copy::class) {
    from(rootProject.file("app/src/main/res/raw/server_cert.pem"))
    into(File(certRes, "raw"))
}

android {
    namespace = "com.sepan.admin"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sepan.admin"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "SERVER_HOST", "\"$serverHost\"")
        buildConfigField("int", "ADMIN_PORT", "$adminPort")
    }

    sourceSets["main"].res.srcDir(certRes)

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
        release {
            signingConfig = if (sepanKeystore != null) signingConfigs.getByName("sepan")
                else signingConfigs.getByName("debug")
            isDebuggable = false
            isMinifyEnabled = false
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
        buildConfig = true
    }
}

tasks.named("preBuild") { dependsOn(copyServerCert) }

dependencies {
    implementation(libs.androidx.core.ktx)
}
