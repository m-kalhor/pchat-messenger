package com.pchat.app

object Config {
    const val HOST = "193.151.148.119"
    const val PORT = 8443
    const val BASE = "https://$HOST:$PORT"
    /** Server cap is 2 GiB of ciphertext; leave room for the per-chunk GCM tags. */
    const val MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024 - 8L * 1024 * 1024
}
