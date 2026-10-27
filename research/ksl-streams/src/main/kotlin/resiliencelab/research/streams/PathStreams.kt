package resiliencelab.research.streams

import ksl.utilities.random.rng.RNStreamFactory
import ksl.utilities.random.rng.RNStreamIfc
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

/** A logical source; the path is the sequence of expanded instance IDs. */
data class StreamKey(val seed: Long, val replication: Long, val path: List<String>, val role: String)

/**
 * Preflights the union of full keys across ALL variants and repetitions before any model runs.
 * Identical keys intentionally share an address (CRN); different keys may never share an address.
 * Each [open] call creates separately owned mutable streams; lookups within that map reuse state.
 */
class StreamPlan(keys: Collection<StreamKey>) {
    val addresses: Map<StreamKey, Long> = checkAddresses(
        keys.map { it.copy(path = it.path.toList()) }.distinct().map { it to addressOf(it) },
    )

    /** Declare one model's sources. Duplicate declarations and keys outside the preflight fail. */
    fun open(keys: Collection<StreamKey>): Map<StreamKey, RNStreamIfc> {
        require(keys.distinct().size == keys.size) { "Duplicate source declaration" }
        require(keys.all { it in addresses }) { "Source absent from experiment preflight" }
        return keys.associateWith { streamAt(addresses.getValue(it)) }
    }
}

/** v1: length-prefixed strict UTF-8, big-endian integers, first 63 non-sign bits of SHA-256. */
internal fun addressOf(key: StreamKey): Long {
    require(key.seed in 0..9_007_199_254_740_991) { "Seed outside JSON-safe nonnegative integer range" }
    require(key.replication >= 0) { "Replication ordinal must be nonnegative" }
    require(key.path.isNotEmpty() && key.path.all { it.isNotEmpty() }) { "Empty block path or segment" }
    require(key.role.isNotEmpty()) { "Empty source role" }
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use { output ->
        fun field(value: String) {
            val buffer = try {
                UTF_8.newEncoder().encode(CharBuffer.wrap(value))
            } catch (error: CharacterCodingException) {
                throw IllegalArgumentException("Malformed Unicode in source identity", error)
            }
            val encoded = ByteArray(buffer.remaining()).also { buffer.get(it) }
            output.writeInt(encoded.size)
            output.write(encoded)
        }
        field("resilience-lab/ksl-path-substream/v1")
        output.writeLong(key.seed)
        output.writeLong(key.replication)
        output.writeInt(key.path.size)
        key.path.forEach(::field)
        field(key.role)
    }
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray())
    return ByteBuffer.wrap(digest).long and Long.MAX_VALUE
}

internal fun checkAddresses(entries: List<Pair<StreamKey, Long>>): Map<StreamKey, Long> {
    val owner = HashMap<Long, StreamKey>()
    for ((key, address) in entries) {
        val previous = owner.putIfAbsent(address, key)
        require(previous == null || previous == key) {
            "Substream address collision at $address: $previous and $key"
        }
    }
    return entries.toMap()
}

/**
 * Each address starts from the SAME fixed native origin and advances by address * 2^76.
 * This stream is externally owned: do not attach it through RandomVariable, reset it, advance it,
 * or combine this scheme with ordinary successive factory streams. Consume fewer than 2^76 raw
 * draws per address. The prototype does not enforce that astronomical draw limit with a counter.
 */
internal fun streamAt(address: Long): RNStreamIfc =
    RNStreamFactory().nextStream().apply { advanceSubStreams(address) }
