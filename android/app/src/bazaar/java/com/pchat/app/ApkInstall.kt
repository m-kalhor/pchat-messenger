package com.pchat.app

import android.content.Context
import java.io.File

/** 1.28.1: the Café Bazaar build never installs APKs itself; updates go through Bazaar (see Updater.openStore). */
object ApkInstall {
    const val SUPPORTED = false
    fun canInstall(ctx: Context): Boolean = false
    fun openInstallPermission(ctx: Context) { }
    fun install(ctx: Context, f: File) { throw UnsupportedOperationException("updates come from Café Bazaar") }
}
