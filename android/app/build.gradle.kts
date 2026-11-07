plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.svorrent.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.svorrent.app"
        minSdk = 26
        targetSdk = 35
        val appVersion = (System.getenv("SVORRENT_VERSION") ?: "1.0.10").removePrefix("v")
        versionName = appVersion
        val parts = appVersion.split(".").mapNotNull { it.toIntOrNull() }
        versionCode = if (parts.size >= 3) parts[0] * 10000 + parts[1] * 100 + parts[2] else 10010

        val gitSha = (System.getenv("SVORRENT_GIT_SHA") ?: "local").take(7)
        buildConfigField("String", "GIT_SHA", "\"$gitSha\"")

        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    signingConfigs {
        getByName("debug") {
        }
        create("release") {
            val ksEnv = System.getenv("SVORRENT_KEYSTORE_PATH")
            val keystoreFile = when {
                !ksEnv.isNullOrBlank() && file(ksEnv).exists() -> file(ksEnv)
                !ksEnv.isNullOrBlank() && rootProject.file(ksEnv).exists() -> rootProject.file(ksEnv)
                rootProject.file("svorrent-release.keystore").exists() -> rootProject.file("svorrent-release.keystore")
                file("svorrent-release.keystore").exists() -> file("svorrent-release.keystore")
                else -> null
            }
            if (keystoreFile != null) {
                storeFile = keystoreFile
                storePassword = System.getenv("SVORRENT_KEYSTORE_PASS") ?: "svorrent123"
                keyAlias = System.getenv("SVORRENT_KEY_ALIAS") ?: "svorrent"
                keyPassword = System.getenv("SVORRENT_KEY_PASS") ?: "svorrent123"
            } else {
                initWith(getByName("debug"))
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ""
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

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Native Torrent C++ engine (libtorrent4j) for Android arm64 / armv7 / x86_64
    implementation("org.libtorrent4j:libtorrent4j:2.1.0-31")
    implementation("org.libtorrent4j:libtorrent4j-android-arm64:2.1.0-31")
    implementation("org.libtorrent4j:libtorrent4j-android-arm:2.1.0-31")
    implementation("org.libtorrent4j:libtorrent4j-android-x86_64:2.1.0-31")

    testImplementation("junit:junit:4.13.2")
}
