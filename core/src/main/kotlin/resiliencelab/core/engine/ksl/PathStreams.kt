package resiliencelab.core.engine.ksl

import ksl.utilities.random.rng.RNStreamFactory
import ksl.utilities.random.rng.RNStreamIfc
import resiliencelab.core.ir.GraphIr
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

/** Stable roles of random sources inside a block (ADR 0006; stage 1 design §4.2). */
enum class StreamRole(
    val id: String,
) {
    ARRIVALS("arrivals"),
    PROCESSING("processing"),
    OUTCOME("outcome"),
    NETWORK("network"),
    JITTER("jitter"),
    ROUTING("routing"),
}

/** Resolves the stream of one random source of one model. */
fun interface StreamSource {
    fun stream(
        path: List<String>,
        role: StreamRole,
    ): RNStreamIfc

    /** Stage-1 string paths remain convenient for direct engine tests and callers. */
    fun stream(
        path: String,
        role: StreamRole,
    ): RNStreamIfc = stream(path.split('/'), role)
}

/** Full identity of a random source; [path] lists the segments of the block instance path. */
data class StreamKey(
    val seed: Long,
    val replication: Long,
    val path: List<String>,
    val role: String,
)

/** Path-based substream addressing (ADR 0006, research S4). */
object PathStreams {
    const val ASSIGNMENT_VERSION = "resilience-lab/ksl-path-substream/v1"
    private const val MAX_SEED = 9_007_199_254_740_991L

    /** First 63 non-sign bits of SHA-256 over the length-prefixed, big-endian encoding of [key]. */
    fun addressOf(key: StreamKey): Long {
        require(key.seed in 0..MAX_SEED) { "Seed outside JSON-safe nonnegative integer range" }
        require(key.replication >= 0) { "Replication ordinal must be nonnegative" }
        require(key.path.isNotEmpty() && key.path.all { it.isNotEmpty() }) { "Empty block path or segment" }
        require(key.role.isNotEmpty()) { "Empty source role" }
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            fun field(value: String) {
                val buffer =
                    try {
                        UTF_8.newEncoder().encode(CharBuffer.wrap(value))
                    } catch (error: CharacterCodingException) {
                        throw IllegalArgumentException("Malformed Unicode in source identity", error)
                    }
                val encoded = ByteArray(buffer.remaining()).also { buffer.get(it) }
                output.writeInt(encoded.size)
                output.write(encoded)
            }
            field(ASSIGNMENT_VERSION)
            output.writeLong(key.seed)
            output.writeLong(key.replication)
            output.writeInt(key.path.size)
            key.path.forEach(::field)
            field(key.role)
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray())
        return ByteBuffer.wrap(digest).long and Long.MAX_VALUE
    }

    /**
     * A fresh stream from the fixed MRG32k3a origin advanced to [address] substreams. The caller owns it: never attach it
     * through `RandomVariable`, reset or advance it.
     */
    fun streamAt(address: Long): RNStreamIfc = RNStreamFactory().nextStream().apply { advanceSubStreams(address) }

    /** Random sources the engine reads for [graph]. */
    fun sources(graph: GraphIr): List<Pair<List<String>, StreamRole>> =
        buildList {
            add(graph.client.pathSegments to StreamRole.ARRIVALS)
            graph.services.forEach {
                add(it.pathSegments to StreamRole.PROCESSING)
                add(it.pathSegments to StreamRole.OUTCOME)
            }
            graph.calls.forEach {
                add(it.pathSegments to StreamRole.NETWORK)
                add(it.pathSegments to StreamRole.JITTER)
            }
            graph.routers.forEach { add(it.pathSegments to StreamRole.ROUTING) }
        }

    /** Keys of all sources of [graph] for one replication. */
    fun keys(
        graph: GraphIr,
        replication: Int,
    ): List<StreamKey> = sources(graph).map { (path, role) -> StreamKey(graph.run.seed, replication.toLong(), path, role.id) }
}

/**
 * Preflighted addresses of every key of an experiment (all variants and replications). Identical keys share an
 * address on purpose (common random numbers); different keys with one address stop the plan.
 */
class StreamPlan internal constructor(
    keys: Collection<StreamKey>,
    addressOf: (StreamKey) -> Long,
) {
    constructor(keys: Collection<StreamKey>) : this(keys, PathStreams::addressOf)

    private val addresses: Map<StreamKey, Long>

    init {
        val owners = HashMap<Long, StreamKey>()
        addresses =
            keys.distinct().associateWith { key ->
                addressOf(key).also { address ->
                    val previous = owners.putIfAbsent(address, key)
                    require(previous == null) { "Substream address collision at $address: $previous and $key" }
                }
            }
    }

    val size: Int get() = addresses.size

    fun address(key: StreamKey): Long =
        addresses[key] ?: throw IllegalArgumentException("Source $key is absent from the experiment stream plan")
}

/** Streams of one model of one replication; each source opens once. */
class PathStreamSource(
    private val plan: StreamPlan,
    private val seed: Long,
    private val replication: Long,
) : StreamSource {
    private val opened = HashMap<StreamKey, RNStreamIfc>()

    override fun stream(
        path: List<String>,
        role: StreamRole,
    ): RNStreamIfc {
        val key = StreamKey(seed, replication, path, role.id)
        return opened.getOrPut(key) { PathStreams.streamAt(plan.address(key)) }
    }
}
