package com.pchat.app

import android.content.Context
import android.telephony.TelephonyManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A country of the sign-in screen (1.17): ISO code, Persian name, dialling code without "+". */
data class Country(val iso: String, val name: String, val dial: String) {
    /** The flag emoji (two regional-indicator letters). */
    val flag: String get() = iso.uppercase().map { String(Character.toChars(0x1F1A5 + it.code)) }.joinToString("")
}

/** Iran first, then by Persian name. The web app keeps the same list in server/src/web/countries.mjs. */
object Countries {
    val all = listOf(
        Country("IR", "ایران", "98"),
        Country("AZ", "آذربایجان", "994"),
        Country("AR", "آرژانتین", "54"),
        Country("ZA", "آفریقای جنوبی", "27"),
        Country("AL", "آلبانی", "355"),
        Country("DE", "آلمان", "49"),
        Country("US", "آمریکا", "1"),
        Country("AD", "آندورا", "376"),
        Country("AO", "آنگولا", "244"),
        Country("AT", "اتریش", "43"),
        Country("ET", "اتیوپی", "251"),
        Country("JO", "اردن", "962"),
        Country("AM", "ارمنستان", "374"),
        Country("UY", "اروگوئه", "598"),
        Country("UZ", "ازبکستان", "998"),
        Country("ES", "اسپانیا", "34"),
        Country("AU", "استرالیا", "61"),
        Country("EE", "استونی", "372"),
        Country("SK", "اسلواکی", "421"),
        Country("SI", "اسلوونی", "386"),
        Country("AF", "افغانستان", "93"),
        Country("EC", "اکوادور", "593"),
        Country("DZ", "الجزایر", "213"),
        Country("SV", "السالوادور", "503"),
        Country("AE", "امارات متحده عربی", "971"),
        Country("ID", "اندونزی", "62"),
        Country("GB", "انگلستان (بریتانیا)", "44"),
        Country("UA", "اوکراین", "380"),
        Country("UG", "اوگاندا", "256"),
        Country("IT", "ایتالیا", "39"),
        Country("IE", "ایرلند", "353"),
        Country("IS", "ایسلند", "354"),
        Country("BH", "بحرین", "973"),
        Country("BR", "برزیل", "55"),
        Country("BY", "بلاروس", "375"),
        Country("BE", "بلژیک", "32"),
        Country("BG", "بلغارستان", "359"),
        Country("BD", "بنگلادش", "880"),
        Country("BA", "بوسنی و هرزگوین", "387"),
        Country("BO", "بولیوی", "591"),
        Country("PY", "پاراگوئه", "595"),
        Country("PK", "پاکستان", "92"),
        Country("PA", "پاناما", "507"),
        Country("PT", "پرتغال", "351"),
        Country("PE", "پرو", "51"),
        Country("TJ", "تاجیکستان", "992"),
        Country("TZ", "تانزانیا", "255"),
        Country("TH", "تایلند", "66"),
        Country("TW", "تایوان", "886"),
        Country("TM", "ترکمنستان", "993"),
        Country("TR", "ترکیه", "90"),
        Country("TN", "تونس", "216"),
        Country("CZ", "جمهوری چک", "420"),
        Country("CN", "چین", "86"),
        Country("DK", "دانمارک", "45"),
        Country("RU", "روسیه", "7"),
        Country("RO", "رومانی", "40"),
        Country("ZM", "زامبیا", "260"),
        Country("ZW", "زیمبابوه", "263"),
        Country("JP", "ژاپن", "81"),
        Country("LK", "سری‌لانکا", "94"),
        Country("SG", "سنگاپور", "65"),
        Country("SE", "سوئد", "46"),
        Country("CH", "سوئیس", "41"),
        Country("SD", "سودان", "249"),
        Country("SY", "سوریه", "963"),
        Country("CL", "شیلی", "56"),
        Country("RS", "صربستان", "381"),
        Country("IQ", "عراق", "964"),
        Country("SA", "عربستان سعودی", "966"),
        Country("OM", "عمان", "968"),
        Country("GH", "غنا", "233"),
        Country("FR", "فرانسه", "33"),
        Country("PS", "فلسطین", "970"),
        Country("FI", "فنلاند", "358"),
        Country("PH", "فیلیپین", "63"),
        Country("CY", "قبرس", "357"),
        Country("KG", "قرقیزستان", "996"),
        Country("KZ", "قزاقستان", "7"),
        Country("QA", "قطر", "974"),
        Country("CR", "کاستاریکا", "506"),
        Country("KH", "کامبوج", "855"),
        Country("CM", "کامرون", "237"),
        Country("CA", "کانادا", "1"),
        Country("HR", "کرواسی", "385"),
        Country("KR", "کرهٔ جنوبی", "82"),
        Country("CO", "کلمبیا", "57"),
        Country("KE", "کنیا", "254"),
        Country("CU", "کوبا", "53"),
        Country("KW", "کویت", "965"),
        Country("GE", "گرجستان", "995"),
        Country("GT", "گواتمالا", "502"),
        Country("LB", "لبنان", "961"),
        Country("LV", "لتونی", "371"),
        Country("LU", "لوکزامبورگ", "352"),
        Country("PL", "لهستان", "48"),
        Country("LY", "لیبی", "218"),
        Country("LT", "لیتوانی", "370"),
        Country("MT", "مالت", "356"),
        Country("MV", "مالدیو", "960"),
        Country("MY", "مالزی", "60"),
        Country("HU", "مجارستان", "36"),
        Country("MA", "مراکش", "212"),
        Country("EG", "مصر", "20"),
        Country("MN", "مغولستان", "976"),
        Country("MK", "مقدونیهٔ شمالی", "389"),
        Country("MX", "مکزیک", "52"),
        Country("MD", "مولداوی", "373"),
        Country("ME", "مونته‌نگرو", "382"),
        Country("MM", "میانمار", "95"),
        Country("NP", "نپال", "977"),
        Country("NO", "نروژ", "47"),
        Country("NG", "نیجریه", "234"),
        Country("NZ", "نیوزیلند", "64"),
        Country("VE", "ونزوئلا", "58"),
        Country("VN", "ویتنام", "84"),
        Country("NL", "هلند", "31"),
        Country("IN", "هند", "91"),
        Country("HK", "هنگ‌کنگ", "852"),
        Country("YE", "یمن", "967"),
        Country("GR", "یونان", "30"),    )
    val iran = all.first()

    /** The SIM's (or network's) country when it is in the list, else Iran. */
    fun guess(ctx: Context): Country {
        val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        val iso = try { (tm?.simCountryIso?.takeIf { it.isNotBlank() } ?: tm?.networkCountryIso).orEmpty().uppercase() } catch (e: Exception) { "" }
        return all.firstOrNull { it.iso == iso } ?: iran
    }

    /**
     * The number as typed in the number field (without the leading 0) joined to the country code:
     * "912 345 6789" with Iran -> "+989123456789". A trunk 0 typed anyway is dropped, and a number pasted
     * with its own "+" or "00" keeps its own country code.
     */
    fun join(c: Country, typed: String): String {
        val t = U.asciiDigits(typed).trim()
        val digits = t.filter { it.isDigit() }
        if (t.startsWith("+") || t.startsWith("00")) return "+" + (if (t.startsWith("00")) digits.drop(2) else digits)
        return "+" + c.dial + digits.trimStart('0')
    }

    /** Only digits, no leading 0 (what the number field keeps); a pasted "+…" is left for [join]. */
    fun clean(typed: String): String {
        val t = U.asciiDigits(typed)
        if (t.trimStart().startsWith("+")) return "+" + t.filter { it.isDigit() }.take(15)
        return t.filter { it.isDigit() }.trimStart('0').take(14)
    }

    /** Looks plausible for the country (Iran: 10 digits starting with 9). */
    fun valid(c: Country, typed: String): Boolean {
        val full = join(c, typed)
        if (full.startsWith("+98")) return Regex("^\\+989\\d{9}$").matches(full)
        return Regex("^\\+[1-9]\\d{6,14}$").matches(full)
    }
}

/** A searchable list of countries (name in Persian, English ISO code or dialling code). */
@Composable
fun CountryPicker(onPick: (Country) -> Unit, onClose: () -> Unit) {
    var q by remember { mutableStateOf("") }
    val term = U.asciiDigits(q).trim().removePrefix("+").lowercase()
    val list = if (term.isEmpty()) Countries.all else Countries.all.filter {
        it.name.contains(term) || it.iso.lowercase() == term || it.dial.startsWith(term)
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("انتخاب کشور") },
        text = {
            androidx.compose.foundation.layout.Column {
                OutlinedTextField(value = q, onValueChange = { q = it }, singleLine = true, label = { Text("جستجو (نام یا پیش‌شماره)") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 380.dp).padding(top = 8.dp)) {
                    items(list, key = { it.iso }) { c ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(c) }.padding(vertical = 10.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(c.flag, fontSize = 20.sp)
                            Spacer(Modifier.width(10.dp))
                            Text(c.name, fontSize = 15.sp, modifier = Modifier.weight(1f))
                            Text("‎+" + c.dial, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                        }
                    }
                    if (list.isEmpty()) item { Text("کشوری پیدا نشد", fontSize = 13.sp, modifier = Modifier.padding(8.dp)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}
