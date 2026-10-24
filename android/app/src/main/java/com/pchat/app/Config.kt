package com.pchat.app

object Config {
    /** Set via the pchat.serverHost / pchat.serverPort Gradle properties (see android/gradle.properties). */
    const val HOST = BuildConfig.SERVER_HOST
    const val PORT = BuildConfig.SERVER_PORT
    const val BASE = "https://$HOST:$PORT"
    /** Server cap is 2 GiB of ciphertext; leave room for the per-chunk GCM tags. */
    const val MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024 - 8L * 1024 * 1024
}
