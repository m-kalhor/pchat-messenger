package com.sepan.admin

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The phone's admin key: EC P-256 made inside the Android Keystore (secure hardware where the phone has it).
 * The private key can never be read out, and signing works only within 30 seconds after the phone's own
 * fingerprint or screen lock. The server keeps only the public key.
 */
object DeviceKey {
    private const val ALIAS = "sepan_admin_device"
    private const val AUTH_SECONDS = 30

    private fun ks(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun exists(): Boolean = try { ks().containsAlias(ALIAS) } catch (e: Exception) { false }

    fun delete() { try { ks().deleteEntry(ALIAS) } catch (e: Exception) { } }

    /** Makes a new key pair (replacing an old one) and returns the public key (base64 X.509 DER). */
    fun create(): String {
        delete()
        val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
        if (Build.VERSION.SDK_INT >= 30) {
            b.setUserAuthenticationParameters(AUTH_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            b.setUserAuthenticationValidityDurationSeconds(AUTH_SECONDS)
        }
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        kpg.initialize(b.build())
        val kp = kpg.generateKeyPair()
        return Base64.encodeToString(kp.public.encoded, Base64.NO_WRAP)
    }

    /**
     * Signs text (SHA256withECDSA, DER). Throws UserNotAuthenticatedException when the phone was not unlocked
     * in the last 30 seconds, KeyPermanentlyInvalidatedException when the screen lock was removed.
     */
    fun sign(text: String): String {
        val key = ks().getKey(ALIAS, null) as PrivateKey
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(key)
        s.update(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(s.sign(), Base64.NO_WRAP)
    }
}
