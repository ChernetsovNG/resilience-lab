package resiliencelab.research;

import java.io.BufferedWriter;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPOutputStream;
import org.apache.arrow.memory.RootAllocator;
import org.apache.arrow.vector.Float8Vector;
import org.apache.arrow.vector.IntVector;
import org.apache.arrow.vector.VectorSchemaRoot;
import org.apache.arrow.vector.ipc.ArrowStreamWriter;
import org.apache.arrow.vector.types.pojo.ArrowType;
import org.apache.arrow.vector.types.pojo.Field;
import org.apache.arrow.vector.types.pojo.FieldType;
import org.apache.arrow.vector.types.pojo.Schema;
import org.apache.arrow.vector.types.FloatingPointPrecision;
import org.apache.parquet.conf.PlainParquetConfiguration;
import org.apache.parquet.example.data.Group;
import org.apache.parquet.example.data.simple.SimpleGroupFactory;
import org.apache.parquet.hadoop.ParquetWriter;
import org.apache.parquet.hadoop.example.ExampleParquetWriter;
import org.apache.parquet.hadoop.metadata.CompressionCodecName;
import org.apache.parquet.io.LocalOutputFile;
import org.apache.parquet.schema.MessageType;
import org.apache.parquet.schema.MessageTypeParser;

/** Standalone synthetic serialization experiment; these rows are not simulation results. */
public final class ResultsVolume {
    static final int BATCH_ROWS = 8192;
    static final long ROW_GROUP_BYTES = 16L * 1024 * 1024;
    static final int PAGE_BYTES = 64 * 1024;
    static final int WARMUP_ROWS = 5000;
    static final int ORIGINAL_REQUESTS = 600_000;
    static final String[] SERIES_COLUMNS = {"node", "window", "arrivalRate", "successRate", "errorRate",
        "timeoutRate", "meanLatencyMs", "p99LatencyMs", "utilization", "queueLength",
        "attemptsPerRequest", "rejectedRate"};
    static final String[] TRACE_COLUMNS = {"requestId", "attemptId", "parentAttemptId", "node",
        "eventSeq", "eventType", "timeMs"};

    private ResultsVolume() {}

    /** Arguments: output directory, series|series-noise|trace, format, blocks, windows, seed, optional count and grid flag. */
    public static void main(String[] args) throws Exception {
        if (args.length < 6 || args.length > 8) {
            throw new IllegalArgumentException("Usage: <outDir> <series|series-noise|trace> <json|json-gzip|csv|arrow|parquet> <blocks> <windows> <seed> [count] [grid]");
        }
        String kind = args[1];
        String format = args[2];
        if (!List.of("series", "series-noise", "trace").contains(kind)
                || !List.of("json", "json-gzip", "csv", "arrow", "parquet").contains(format)) {
            throw new IllegalArgumentException("Unknown kind or format");
        }
        int blocks = Integer.parseInt(args[3]);
        int windows = Integer.parseInt(args[4]);
        long seed = Long.parseLong(args[5]);
        int count = args.length >= 7 ? Integer.parseInt(args[6]) : 1;
        if (count <= 0) throw new IllegalArgumentException("count must be positive");
        boolean grid = args.length == 8;
        if (grid && (!args[7].equals("grid") || !kind.equals("series") || count != 250)) {
            throw new IllegalArgumentException("grid requires kind=series and count=250");
        }
        Table first = new Table(kind, blocks, windows, seed, grid ? 0 : -1);
        Path directory = Path.of(args[0]).toAbsolutePath();
        Files.createDirectories(directory);
        String extension = format.equals("json-gzip") ? "json.gz" : format;
        Path warmup = Files.createTempFile(directory, ".warmup-", "." + extension);
        Files.delete(warmup);
        Stats warmupStats;
        try {
            warmupStats = write(warmup, format, first, WARMUP_ROWS);
        } finally {
            Files.deleteIfExists(warmup);
        }
        for (int dataset = 0; dataset < count; dataset++) {
            Table table = new Table(kind, blocks, windows, Math.addExact(seed, dataset), grid ? dataset / 10 : -1);
            Path path = directory.resolve(kind + "-" + blocks + "-" + windows + "-" + table.seed + "." + extension);
            Files.deleteIfExists(path);
            long started = System.nanoTime();
            Stats stats = write(path, format, table, Long.MAX_VALUE);
            double writeMs = (System.nanoTime() - started) / 1_000_000.0;
            if (Math.abs(stats.checksum) > 9_007_199_254_740_991L) {
                throw new IllegalStateException("Checksum exceeds the exact JavaScript integer range");
            }
            // A separate bounded pass excludes canonical hashing from generation + serialization timing.
            String canonicalSha256 = canonicalSha256(table);
            String namesJson = "[" + String.join(",", Arrays.stream(table.names).map(ResultsVolume::quote).toList()) + "]";
            String trace = kind.equals("trace") ? String.format(Locale.ROOT,
                ",\"originalRequests\":%d,\"sampledRequests\":%d,\"attempts\":%d,\"events\":%d,"
                    + "\"sampleRate\":0.01,\"requestRatePerSecond\":1000,\"durationSeconds\":600,\"hops\":%d",
                ORIGINAL_REQUESTS, stats.sampledRequests, stats.attempts, stats.rows, table.hops) : "";
            String gridMetadata = grid ? String.format(Locale.ROOT,
                ",\"gridCell\":%d,\"replication\":%d,\"arrivalMultiplier\":%.2f,\"latencyMultiplier\":%.2f",
                table.gridCell, dataset % 10, table.arrivalMultiplier, table.latencyMultiplier) : "";
            System.out.printf(Locale.ROOT,
                "{\"kind\":%s,\"format\":%s,\"blocks\":%d,\"windows\":%d,\"seed\":%d,"
                    + "\"rows\":%d,\"columnCount\":%d,\"columns\":%s,\"bytes\":%d,\"writeMs\":%.6f,"
                    + "\"checksum\":%d,\"canonicalSha256\":%s,\"path\":%s,\"datasetIndex\":%d,"
                    + "\"warmupRows\":%d,\"warmupMode\":\"once-per-process\",\"arrowBatchRows\":%d,"
                    + "\"parquetRowGroupBytes\":%d,\"parquetPageBytes\":%d%s%s}%n",
                quote(kind), quote(format), blocks, windows, table.seed, stats.rows, table.names.length, namesJson,
                Files.size(path), writeMs, stats.checksum, quote(canonicalSha256), quote(path.toString()), dataset,
                warmupStats.rows, BATCH_ROWS, ROW_GROUP_BYTES, PAGE_BYTES, trace, gridMetadata);
        }
    }

    static String canonicalSha256(Table table) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        ByteBuffer bytes = ByteBuffer.allocate(BATCH_ROWS * table.names.length * Double.BYTES).order(ByteOrder.LITTLE_ENDIAN);
        table.generate(Long.MAX_VALUE, (row, index) -> {
            if (bytes.remaining() < row.length * Double.BYTES) {
                digest.update(bytes.array(), 0, bytes.position());
                bytes.clear();
            }
            for (double value : row) bytes.putDouble(value);
        });
        digest.update(bytes.array(), 0, bytes.position());
        return HexFormat.of().formatHex(digest.digest());
    }

    static Stats write(Path path, String format, Table table, long limit) throws Exception {
        return switch (format) {
            case "json", "json-gzip", "csv" -> writeText(path, format, table, limit);
            case "arrow" -> writeArrow(path, table, limit);
            case "parquet" -> writeParquet(path, table, limit);
            default -> throw new IllegalArgumentException(format);
        };
    }

    static Stats writeText(Path path, String format, Table table, long limit) throws Exception {
        boolean json = !format.equals("csv");
        try (OutputStream file = Files.newOutputStream(path);
             OutputStream compressed = format.equals("json-gzip") ? new GZIPOutputStream(file, 64 * 1024) : file;
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(compressed, StandardCharsets.UTF_8), 64 * 1024)) {
            writer.write(json ? "{\"columns\":[" : "");
            for (int column = 0; column < table.names.length; column++) {
                if (column > 0) writer.write(',');
                writer.write(json ? quote(table.names[column]) : table.names[column]);
            }
            writer.write(json ? "],\"rows\":[" : "\n");
            StringBuilder line = new StringBuilder(256);
            Stats stats = table.generate(limit, (row, index) -> {
                line.setLength(0);
                if (json) line.append(index == 0 ? "[" : ",[");
                for (int column = 0; column < row.length; column++) {
                    if (column > 0) line.append(',');
                    if (column < table.intColumns) line.append((int) row[column]);
                    else line.append(row[column]);
                }
                line.append(json ? "]" : "\n");
                writer.write(line.toString());
            });
            if (json) writer.write("]}");
            return stats;
        }
    }

    static Stats writeArrow(Path path, Table table, long limit) throws Exception {
        List<Field> fields = new ArrayList<>();
        for (int column = 0; column < table.names.length; column++) {
            ArrowType type = column < table.intColumns ? new ArrowType.Int(32, true)
                : new ArrowType.FloatingPoint(FloatingPointPrecision.DOUBLE);
            fields.add(new Field(table.names[column], FieldType.notNullable(type), null));
        }
        try (RootAllocator allocator = new RootAllocator(256L * 1024 * 1024);
             VectorSchemaRoot root = VectorSchemaRoot.create(new Schema(fields), allocator);
             OutputStream output = Files.newOutputStream(path);
             ArrowStreamWriter writer = new ArrowStreamWriter(root, null, output)) {
            for (var vector : root.getFieldVectors()) vector.setInitialCapacity(BATCH_ROWS);
            root.allocateNew();
            writer.start();
            Stats stats = table.generate(limit, (row, index) -> {
                int position = (int) (index % BATCH_ROWS);
                for (int column = 0; column < row.length; column++) {
                    if (column < table.intColumns) ((IntVector) root.getVector(column)).setSafe(position, (int) row[column]);
                    else ((Float8Vector) root.getVector(column)).setSafe(position, row[column]);
                }
                if (position == BATCH_ROWS - 1) {
                    root.setRowCount(BATCH_ROWS);
                    writer.writeBatch();
                }
            });
            int remainder = (int) (stats.rows % BATCH_ROWS);
            if (remainder > 0) {
                root.setRowCount(remainder);
                writer.writeBatch();
            }
            writer.end();
            return stats;
        }
    }

    static Stats writeParquet(Path path, Table table, long limit) throws Exception {
        StringBuilder definition = new StringBuilder("message ").append(table.kind).append(" {");
        for (int column = 0; column < table.names.length; column++) {
            definition.append(" required ").append(column < table.intColumns ? "int32 " : "double ")
                .append(table.names[column]).append(';');
        }
        MessageType schema = MessageTypeParser.parseMessageType(definition.append('}').toString());
        SimpleGroupFactory groups = new SimpleGroupFactory(schema);
        try (ParquetWriter<Group> writer = ExampleParquetWriter.builder(new LocalOutputFile(path))
                .withConf(new PlainParquetConfiguration()).withType(schema)
                .withCompressionCodec(CompressionCodecName.SNAPPY).withRowGroupSize(ROW_GROUP_BYTES)
                .withPageSize(PAGE_BYTES).build()) {
            return table.generate(limit, (row, index) -> {
                Group group = groups.newGroup();
                for (int column = 0; column < row.length; column++) {
                    if (column < table.intColumns) group.add(column, (int) row[column]);
                    else group.add(column, row[column]);
                }
                writer.write(group);
            });
        }
    }

    @FunctionalInterface
    interface Sink {
        void accept(double[] row, long index) throws Exception;
    }

    static final class Stats {
        long rows;
        long checksum;
        long sampledRequests;
        long attempts;

        void emit(double[] row, Sink sink) throws Exception {
            sink.accept(row, rows);
            for (double value : row) checksum = Math.addExact(checksum, Math.round(value * 1000));
            rows++;
        }
    }

    static final class Table {
        final String kind;
        final int blocks;
        final int windows;
        final long seed;
        final int hops;
        final String[] names;
        final int intColumns;
        final int gridCell;
        final double arrivalMultiplier;
        final double latencyMultiplier;

        Table(String kind, int blocks, int windows, long seed) {
            this(kind, blocks, windows, seed, -1);
        }

        Table(String kind, int blocks, int windows, long seed, int gridCell) {
            if (blocks <= 0 || windows <= 0) throw new IllegalArgumentException("blocks and windows must be positive");
            if (gridCell < -1 || gridCell > 24 || (gridCell >= 0 && !kind.equals("series"))) {
                throw new IllegalArgumentException("gridCell must be -1 or a series cell in [0,24]");
            }
            this.gridCell = gridCell;
            arrivalMultiplier = gridCell < 0 ? 1 : 1 + 0.25 * (gridCell % 5);
            latencyMultiplier = gridCell < 0 ? 1 : 1 + 0.25 * (gridCell / 5);
            this.kind = kind;
            this.blocks = blocks;
            this.windows = windows;
            this.seed = seed;
            hops = Math.min(blocks, 10);
            names = kind.equals("trace") ? TRACE_COLUMNS : SERIES_COLUMNS;
            intColumns = kind.equals("trace") ? 6 : 2;
        }

        Stats generate(long limit, Sink sink) throws Exception {
            return kind.equals("trace") ? trace(limit, sink) : series(limit, sink);
        }

        Stats series(long limit, Sink sink) throws Exception {
            Stats stats = new Stats();
            double[] row = new double[names.length];
            long count = Math.min(limit, (long) blocks * windows);
            for (long index = 0; index < count; index++) {
                int node = (int) (index / windows);
                int window = (int) (index % windows);
                if (kind.equals("series-noise")) {
                    // Synthetic entropy stress only: these ten columns have no physical metric semantics.
                    row[0] = node;
                    row[1] = window;
                    for (int column = 2; column < row.length; column++) {
                        row[column] = unit(seed ^ (index * 0x9e3779b97f4a7c15L)
                            ^ ((long) column * 0xd1b54a32d192ed03L)) * 1000;
                    }
                    stats.emit(row, sink);
                    continue;
                }
                double noise = unit(seed ^ ((long) node << 32) ^ window);
                double phase = (double) window / windows;
                boolean degraded = node % 7 == 0 && phase >= 0.4 && phase < 0.55;
                int error = (int) Math.round((0.002 + (degraded ? 0.05 : 0) + noise * 0.005) * 1000);
                int timeout = (int) Math.round((0.001 + (degraded ? 0.2 : 0) + noise * 0.003) * 1000);
                row[0] = node;
                row[1] = window;
                row[2] = round(100 + node % 31 * 13 + Math.sin(window * 0.01 + node * 0.1) * 7 + noise * 3);
                row[3] = (1000 - error - timeout) / 1000.0;
                row[4] = error / 1000.0;
                row[5] = timeout / 1000.0;
                row[6] = round(12 + node % 17 + noise * 5 + (degraded ? 150 : 0));
                row[7] = round(row[6] * (3 + noise) + (degraded ? 100 : 0));
                row[8] = round(0.35 + node % 11 * 0.03 + (degraded ? 0.25 : 0) + noise * 0.04);
                row[9] = round((degraded ? 20 : 0) + noise * 2 + node % 7 * 0.2);
                row[10] = round(1 + row[5] * 0.8 + row[4] * 0.5 + noise * 0.003);
                row[11] = round((degraded ? 0.02 : 0.0001) + noise * 0.002);
                if (gridCell >= 0) {
                    row[2] = round(row[2] * arrivalMultiplier);
                    row[6] = round(row[6] * latencyMultiplier);
                    row[7] = round(row[7] * latencyMultiplier);
                }
                stats.emit(row, sink);
            }
            return stats;
        }

        Stats trace(long limit, Sink sink) throws Exception {
            Stats stats = new Stats();
            double[] row = new double[names.length];
            for (int request = 0; request < ORIGINAL_REQUESTS && stats.rows < limit; request++) {
                if (Math.floorMod(mix(seed ^ request), 100) != 0) continue;
                stats.sampledRequests++;
                int sequence = 0;
                int parent = -1;
                for (int node = 0; node < hops && stats.rows < limit; node++) {
                    int count = Math.floorMod(mix(seed ^ ((long) request << 16) ^ node), 5) == 0 ? 2 : 1;
                    int lastAttempt = parent;
                    for (int attempt = 0; attempt < count && stats.rows < limit; attempt++) {
                        int id = request * hops * 2 + node * 2 + attempt + 1;
                        stats.attempts++;
                        for (int event = 0; event < 4 && stats.rows < limit; event++) {
                            row[0] = request;
                            row[1] = id;
                            row[2] = parent;
                            row[3] = node;
                            row[4] = sequence++;
                            row[5] = event;
                            row[6] = round(request + node * 10 + attempt * 5 + event * 1.25
                                + unit(seed ^ id) * 0.5);
                            stats.emit(row, sink);
                        }
                        lastAttempt = id;
                    }
                    parent = lastAttempt;
                }
            }
            return stats;
        }
    }

    static long mix(long value) {
        value = (value ^ (value >>> 30)) * 0xbf58476d1ce4e5b9L;
        value = (value ^ (value >>> 27)) * 0x94d049bb133111ebL;
        return value ^ (value >>> 31);
    }

    static double unit(long value) {
        return (mix(value) >>> 11) * 0x1.0p-53;
    }

    static double round(double value) {
        return Math.round(value * 1000) / 1000.0;
    }

    static String quote(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\"";
    }
}
