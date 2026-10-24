package com.pchat.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class Identity(val priv: PrivateKey, val pubB64: String)

/**
 * End-to-end encryption using only the platform crypto (no extra libraries):
 *  - identity key: EC P-256, private key wrapped by an Android Keystore AES key
 *  - per message: random AES-256 key K encrypts the content (AES-GCM)
 *  - K is wrapped for every recipient with a key derived from ECDH(sender, recipient) + HKDF-SHA256
 * The server only ever sees ciphertext.
 */
object Crypto {
    private val rnd = SecureRandom()
    private const val KS = "AndroidKeyStore"
    private const val ALIAS = "pchat_wrap_v1"

    fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)
    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { rnd.nextBytes(it) }

    private fun wrapKey(): SecretKey {
        val ks = KeyStore.getInstance(KS).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS)
        g.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return g.generateKey()
    }

    fun loadOrCreateIdentity(ctx: Context): Identity {
        val sp = ctx.getSharedPreferences("identity", Context.MODE_PRIVATE)
        val stored = sp.getString("priv", null)
        val pub = sp.getString("pub", null)
        val kf = KeyFactory.getInstance("EC")
        if (stored != null && pub != null) {
            try {
                val raw = unb64(stored)
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
                val pk = kf.generatePrivate(PKCS8EncodedKeySpec(c.doFinal(raw, 12, raw.size - 12)))
                return Identity(pk, pub)
            } catch (e: Exception) {
                // fall through and create a fresh identity
            }
        }
        val g = KeyPairGenerator.getInstance("EC")
        g.initialize(ECGenParameterSpec("secp256r1"))
        val kp = g.generateKeyPair()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, wrapKey())
        val iv = c.iv
        val enc = iv + c.doFinal(kp.private.encoded)
        val pubB64 = b64(kp.public.encoded)
        sp.edit().putString("priv", b64(enc)).putString("pub", pubB64).apply()
        return Identity(kp.private, pubB64)
    }

    fun fingerprint(pubB64: String): String {
        val h = MessageDigest.getInstance("SHA-256").digest(unb64(pubB64))
        return h.take(16).joinToString("") { "%02X".format(it) }.chunked(4).joinToString(" ")
    }

    private fun hkdf(ikm: ByteArray, info: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        mac.update(info)
        mac.update(1.toByte())
        return mac.doFinal()
    }

    private fun pairKey(my: Identity, otherPub: String, a: String, b: String): SecretKey {
        val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(unb64(otherPub)))
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(my.priv)
        ka.doPhase(pub, true)
        val info = ("pchat-v1|" + listOf(a, b).sorted().joinToString("|")).toByteArray()
        return SecretKeySpec(hkdf(ka.generateSecret(), info), "AES")
    }

    private fun seal(key: SecretKey, plain: ByteArray, aad: ByteArray): ByteArray {
        val iv = randomBytes(12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return iv + c.doFinal(plain)
    }

    private fun open(key: SecretKey, blob: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, blob.copyOfRange(0, 12)))
        c.updateAAD(aad)
        return c.doFinal(blob, 12, blob.size - 12)
    }

    fun sealFile(fileKey: ByteArray, data: ByteArray): ByteArray =
        seal(SecretKeySpec(fileKey, "AES"), data, "file".toByteArray())

    fun openFile(fileKey: ByteArray, blob: ByteArray): ByteArray =
        open(SecretKeySpec(fileKey, "AES"), blob, "file".toByteArray())


    // ---------------- chunked file encryption (v2) ----------------
    // Plaintext is split in 1 MiB chunks; each chunk is AES-256-GCM sealed with
    //   nonce = 8-byte random file prefix + 4-byte big-endian chunk index
    //   AAD   = "fc|<index>|<1 if last chunk else 0>"   (prevents reordering / truncation)
    // The ciphertext of chunk i is therefore deterministic, so an interrupted upload can resume.
    const val FILE_CHUNK = 1 shl 20
    const val TAG = 16
    const val CIPHER_CHUNK = FILE_CHUNK + TAG

    fun chunkCount(plain: Long): Int = if (plain <= 0) 1 else ((plain + FILE_CHUNK - 1) / FILE_CHUNK).toInt()
    fun cipherSize(plain: Long): Long = plain + TAG.toLong() * chunkCount(plain)

    /** fkey string for v2 files: base64(key) + "." + base64(8-byte nonce prefix). Legacy keys have no dot. */
    fun newFileKey(): String = b64(randomBytes(32)) + "." + b64(randomBytes(8))
    fun isChunked(fkey: String): Boolean = fkey.contains('.')

    private fun chunkNonce(prefix: ByteArray, index: Int): ByteArray {
        val n = ByteArray(12)
        System.arraycopy(prefix, 0, n, 0, 8)
        n[8] = (index ushr 24).toByte(); n[9] = (index ushr 16).toByte(); n[10] = (index ushr 8).toByte(); n[11] = index.toByte()
        return n
    }

    private fun chunkAad(index: Int, last: Boolean) = "fc|$index|${if (last) 1 else 0}".toByteArray()

    fun sealChunk(fkey: String, index: Int, last: Boolean, buf: ByteArray, len: Int): ByteArray {
        val (k, np) = fkey.split('.').let { unb64(it[0]) to unb64(it[1]) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(128, chunkNonce(np, index)))
        c.updateAAD(chunkAad(index, last))
        return c.doFinal(buf, 0, len)
    }

    fun openChunk(fkey: String, index: Int, last: Boolean, buf: ByteArray, len: Int): ByteArray {
        val (k, np) = fkey.split('.').let { unb64(it[0]) to unb64(it[1]) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(128, chunkNonce(np, index)))
        c.updateAAD(chunkAad(index, last))
        return c.doFinal(buf, 0, len)
    }

    /** recipients: username -> public key (must include the sender itself). */
    fun encryptFor(my: Identity, me: String, target: String, recipients: Map<String, String>, plain: ByteArray): String {
        val aad = "$me|$target".toByteArray()
        val k = SecretKeySpec(randomBytes(32), "AES")
        val keys = JSONObject()
        for ((u, pub) in recipients) {
            val sk = if (u == me) pairKey(my, my.pubB64, me, me) else pairKey(my, pub, me, u)
            keys.put(u, b64(seal(sk, k.encoded, aad)))
        }
        return JSONObject().put("v", 1).put("c", b64(seal(k, plain, aad))).put("k", keys).toString()
    }

    fun decryptFrom(my: Identity, me: String, sender: String, target: String, senderPub: String?, payload: String): ByteArray {
        val o = JSONObject(payload)
        val wrapped = o.getJSONObject("k").optString(me, "")
        require(wrapped.isNotEmpty()) { "not addressed to me" }
        val aad = "$sender|$target".toByteArray()
        val sk = if (sender == me) pairKey(my, my.pubB64, me, me) else pairKey(my, senderPub!!, sender, me)
        val k = SecretKeySpec(open(sk, unb64(wrapped), aad), "AES")
        return open(k, unb64(o.getString("c")), aad)
    }
}
