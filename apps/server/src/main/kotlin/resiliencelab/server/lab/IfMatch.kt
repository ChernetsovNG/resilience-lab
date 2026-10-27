package resiliencelab.server.lab

/** `If-Match` with strong comparison (RFC 9110 §13.1.1): `*` matches any stored version, weak tags never match. */
internal object IfMatch {
    fun accepts(
        header: String,
        current: String,
    ): Boolean {
        val tags = header.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        return tags == listOf("*") || tags.any { it == "\"$current\"" }
    }
}
