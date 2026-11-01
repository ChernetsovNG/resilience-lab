# Методика измерения стоимости прогона

Дополнение к [исследованию #406](2026-11-01-cost-estimate.md). Все команды выполняются из корня репозитория с JDK 25 и Python 3. Изменения исходников приложения не нужны: диагностический агент преобразует классы только в памяти отдельной JVM. Каталог измерений создаётся отдельно от рабочей области пользователя.

## Подготовка

```sh
./gradlew :apps:cli:installDist
export COST_REPO="$PWD"
export COST_ROOT="$(mktemp -d)"
python3 - <<'PYCODE'
import json, os, pathlib, re, shutil
repo = pathlib.Path(os.environ['COST_REPO'])
root = pathlib.Path(os.environ['COST_ROOT'])
for name in ('retry-storm', 'checkout', 'checkout-replicas'):
    shutil.copytree(repo / 'examples' / name, root / 'workspace' / name,
                    ignore=shutil.ignore_patterns('.results'))
shutil.copytree(root / 'workspace/checkout-replicas', root / 'workspace/ramp')
p = root / 'workspace/ramp/checkout-replicas.model.json'
model = json.loads(p.read_text())
model['blocks']['mobile-app']['params']['load'] = {'points': [
    {'time': '0s', 'rate': '120/s'}, {'time': '70s', 'rate': '900/s'}]}
p.write_text(json.dumps(model, ensure_ascii=False, indent=2) + '\n')
p = root / 'workspace/ramp/checkout-replicas.experiment.json'
experiment = json.loads(p.read_text())
experiment['variants'] = [{'id': 'baseline', 'label': 'Baseline'}]
experiment['grid'] = [
    {'path': 'api-gateway-to-order-service.timeout', 'values': ['400ms', '800ms', '1200ms']},
    {'path': 'api-gateway-to-order-service.attempts', 'values': [1, 2, 3]}]
for window in ('100ms', '10ms'):
    experiment['execution']['window'] = window
    (p.parent / ('ramp-' + window + '.experiment.json')).write_text(
        json.dumps(experiment, ensure_ascii=False, indent=2) + '\n')
text = (repo / 'docs/research/2026-11-01-cost-estimate-method.md').read_text()
blocks = re.findall(r'```java\n(.*?)\n```', text, re.S)
assert len(blocks) == 2
for name, code in zip(('Probe.java', 'Bench.java'), blocks):
    (root / name).write_text(code + '\n')
(root / 'manifest.mf').write_text('Premain-Class: Probe\n')
(root / 'classes').mkdir()
PYCODE
javac -cp "$COST_REPO/apps/cli/build/install/cli/lib/*" -d "$COST_ROOT/classes" "$COST_ROOT/Probe.java" "$COST_ROOT/Bench.java"
jar cfm "$COST_ROOT/probe.jar" "$COST_ROOT/manifest.mf" -C "$COST_ROOT/classes" .
```

Три запуска одной конфигурации в одной JVM: первый включает начальную компиляцию JIT; следующие два сохраняются отдельно. `estimate` и старт JVM находятся вне измеряемого интервала `Lab.run`. Для короткого `retry-storm` выполнено шесть запусков: прогрев заметен и после первого.

```sh
java -Xms512m -Xmx2g -XX:+UseG1GC   -javaagent:"$COST_ROOT/probe.jar"   -cp "$COST_ROOT/classes:$COST_REPO/apps/cli/build/install/cli/lib/*"   Bench "$COST_ROOT/workspace" ramp/ramp-10ms.experiment.json 8 3
```

Аргументы после `Bench`: рабочая область, путь эксперимента внутри неё, число потоков и число последовательных запусков. Другие случаи: `retry-storm/retry-storm.experiment.json`, `checkout/checkout.experiment.json`, `checkout/checkout-grid.experiment.json`, `checkout-replicas/checkout-replicas.experiment.json`, `ramp/ramp-100ms.experiment.json`. Число потоков сравнивается на одном и том же файле, seed не меняется. Для контроля накладных расходов агента уберите только `-javaagent`; нулевые поля фаз и событий в таком выводе означают отсутствие измерения.

На macOS фон измерялся командой `top -l 0 -s 2 -n 0`. Контрольная серия начиналась после двух последовательных проверок с не менее чем 90 % свободного CPU; загрузка записывалась и во время расчёта. Чужие процессы не останавливались. Перед воспроизведением завершите свои параллельные сборки и прогоны. При сравнении времени сохраняйте параметры heap: в этой серии `-Xmx2g`; без него на измеренной машине JVM выбирала максимум 12 GiB.

Измеритель использует `FileWorkspace(scanInterval=10s, historyLimit=1024)`, сервер — значения по умолчанию `1s` и `1000`. В измерителе не вызывается `Workspace.changes`, поэтому наблюдатель файлов не запускается; результаты в `.results` также исключены из журнала документов. Эти параметры не участвуют в измеренном одиночном `Lab.run`. Опрос изменений рабочей области открытым UI и прочие HTTP-запросы сервера в измерения не входят.

В итоговом CSV `pilot-*` обозначает предварительные запуски, имена без префикса `quiet-` — первую диагностическую серию, `quiet-*` — серии после проверки свободного CPU. `ramp100` и `ramp10` различаются окном; суффикс `plain` означает запуск без агента. Пустые поля означают отсутствие измерения. `actual_rows`, `instance_rows`, `raw_bytes` и `parts` добавлены из индексов артефакта. `cpu_idle_*` — общая свободная доля CPU по отсчётам `top`, включая нагрузку измеряемой JVM; это не отдельное измерение фона. Включены отсчёты от двух секунд после начала `Lab.run` до его окончания. Для короткого вызова таких отсчётов может не быть.

## Что измеряется

- `wall_s` — полный вызов `Lab.run`, включая чтение входных файлов, расчёт, запись, сводку и манифест.
- `last_progress_s` — время до последнего `completed == total`; разность с `wall_s` показывает работу после завершения задач.
- `executor_s` — `ExperimentExecutor.execute`, то есть параллельные задачи вместе с записью их результатов. Последующая агрегация `ExperimentExecutor.run` находится за этой границей.
- `model_thread_s` — сумма длительностей `ReliabilityModel.runReplication` по потокам. В неё входит `window_write_thread_s`; складывать их нельзя. Эти суммы также нельзя прибавлять к `executor_s`.
- `finish_thread_s` и `replication_write_thread_s` — суммы времени завершения частей рядов и записи итогов повторений; они входят в `executor_s`.
- `summary_s` — последовательный `ArtifactWriter.summarize`: чтение и разбор сохранённых рядов и итогов, поиск насыщения и агрегация.
- `publish_s` — запись сводки, вычисление хешей и публикация манифеста.
- `actual_events` — сумма `Executive.numEventsExecuted` после каждого повторения; счётчик читается один раз, обработчики отдельных событий не инструментируются. Отменённые события в этот счётчик не входят; операции с ними всё равно могут требовать времени.
- `cpu_s` и `gc_ms` — процессорное время JVM и сумма времени сборщиков мусора из MXBean. Это отдельные показатели, их нельзя складывать с `wall_s`.

Агент фиксирует только нормальные возвраты методов. Прерванный прогон исключается; в таблицу входят только завершённые вызовы. Для одинаковых входов проверяются одинаковые `manifest.parts`, чтобы сравнение времени не скрывало изменения результата.

Число реально записанных строк считается по каждому `index.json`: `(untilWindow - fromWindow) * (len(nodes) + len(connections) + len(classes))`, с суммированием по всем частям и задачам. `INSTANCE` и `GROUP` учитываются отдельно. `uncompressedBytes` из индексов даёт размер рядов до gzip; размер файлов частей — размер после gzip.

## Диагностический агент

```java
import java.lang.classfile.*;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.*;
import java.lang.instrument.*;
import java.security.ProtectionDomain;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.LongAdder;
import static java.lang.constant.ConstantDescs.*;

public class Probe {
    static final Map<String, Set<String>> TARGETS = Map.of(
        "resiliencelab/core/engine/ksl/ReliabilityModel", Set.of("runReplication"),
        "resiliencelab/core/execution/ExperimentExecutor", Set.of("execute"),
        "resiliencelab/core/results/ArtifactWriter", Set.of("summarize", "writeReplication", "write"),
        "resiliencelab/core/results/SeriesWriter", Set.of("writeWindow", "finish"));
    public static final ConcurrentHashMap<String, LongAdder> nanos = new ConcurrentHashMap<>();
    public static final ConcurrentHashMap<String, LongAdder> calls = new ConcurrentHashMap<>();
    public static final LongAdder events = new LongAdder();
    static final ThreadLocal<Map<String, ArrayDeque<Long>>> starts = ThreadLocal.withInitial(HashMap::new);
    static volatile Throwable failure;
    public static void premain(String args, Instrumentation inst) {
        inst.addTransformer(new ClassFileTransformer() {
            @Override public byte[] transform(ClassLoader loader, String name, Class<?> type,
                    ProtectionDomain domain, byte[] bytes) {
                if (!TARGETS.containsKey(name)) return null;
                try {
                    return ClassFile.of().transformClass(ClassFile.of().parse(bytes), (builder, element) -> {
                        if (element instanceof MethodModel method && TARGETS.get(name).contains(method.methodName().stringValue())) {
                            String key = name.substring(name.lastIndexOf('/') + 1) + "." + method.methodName().stringValue();
                            if (key.endsWith(".write") && method.methodTypeSymbol().parameterCount() != 4) {
                                builder.with(element); return;
                            }
                            builder.transformMethod(method, MethodTransform.transformingCode(new CodeTransform() {
                                @Override public void atStart(CodeBuilder code) {
                                    code.ldc(key).invokestatic(ClassDesc.of("Probe"), "enter", MethodTypeDesc.of(CD_void, CD_String));
                                }
                                @Override public void accept(CodeBuilder code, CodeElement instruction) {
                                    if (instruction instanceof ReturnInstruction) {
                                        code.ldc(key).aload(0).invokestatic(ClassDesc.of("Probe"), "leave",
                                            MethodTypeDesc.of(CD_void, CD_String, CD_Object));
                                    }
                                    code.with(instruction);
                                }
                            }));
                        } else builder.with(element);
                    });
                } catch (Throwable e) { failure = e; throw new RuntimeException(e); }
            }
        });
    }
    public static void enter(String key) {
        starts.get().computeIfAbsent(key, k -> new ArrayDeque<>()).push(System.nanoTime());
    }
    public static void leave(String key, Object instance) {
        long elapsed = System.nanoTime() - starts.get().get(key).pop();
        nanos.computeIfAbsent(key, k -> new LongAdder()).add(elapsed);
        calls.computeIfAbsent(key, k -> new LongAdder()).increment();
        if (key.equals("ReliabilityModel.runReplication")) {
            try {
                var getter = Class.forName("ksl.simulation.ModelElement").getDeclaredMethod("getExecutive");
                getter.setAccessible(true);
                Object executive = getter.invoke(instance);
                events.add((Long) executive.getClass().getMethod("getNumEventsExecuted").invoke(executive));
            } catch (ReflectiveOperationException e) { throw new RuntimeException(e); }
        }
    }
    public static void reset() { nanos.clear(); calls.clear(); events.reset(); }
    public static double seconds(String key) { return nanos.getOrDefault(key, new LongAdder()).sum() / 1e9; }
}
```

## Запуск через штатный фасад

```java
import java.nio.file.*;
import java.time.Duration;
import java.lang.management.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import resiliencelab.core.workspace.FileWorkspace;
import resiliencelab.core.compiler.ModelCompiler;
import resiliencelab.core.execution.ExperimentExecutor;
import resiliencelab.core.lab.Lab;
import kotlin.Unit;

public class Bench {
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String experiment = args[1];
        int workers = Integer.parseInt(args[2]);
        int repetitions = Integer.parseInt(args[3]);
        var os = (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        try (var workspace = new FileWorkspace(root, Duration.ofSeconds(10), 1024);
             var executor = new ExperimentExecutor(workers);
             var lab = new Lab(workspace, new ModelCompiler(), executor)) {
            var estimate = lab.estimate(experiment, Map.of(), workers);
            System.out.println("trial,workers,tasks,estimated_s,estimated_events,rows,wall_s,cpu_s,last_progress_s,executor_s,model_thread_s,window_write_thread_s,finish_thread_s,replication_write_thread_s,summary_s,publish_s,actual_events,gc_ms,run_directory,begin_epoch_ms");
            for (int trial = 0; trial < repetitions; trial++) {
                String id = "probe-" + UUID.randomUUID();
                Probe.reset();
                AtomicLong last = new AtomicLong();
                long gc = ManagementFactory.getGarbageCollectorMXBeans().stream().mapToLong(x -> Math.max(0, x.getCollectionTime())).sum();
                long cpu = os.getProcessCpuTime();
                long epoch = System.currentTimeMillis();
                long begin = System.nanoTime();
                var result = lab.run(experiment, id, () -> false, (done, total) -> {
                    if (done.equals(total)) last.set(System.nanoTime());
                    return Unit.INSTANCE;
                });
                double wall = (System.nanoTime() - begin) / 1e9;
                double cpuSeconds = (os.getProcessCpuTime() - cpu) / 1e9;
                long gcMs = ManagementFactory.getGarbageCollectorMXBeans().stream().mapToLong(x -> Math.max(0, x.getCollectionTime())).sum() - gc;
                if (Probe.failure != null) throw new AssertionError(Probe.failure);
                System.out.printf(Locale.ROOT, "%d,%d,%d,%.9f,%.3f,%d,%.9f,%.9f,%.9f,%.9f,%.9f,%.9f,%.9f,%.9f,%.9f,%.9f,%d,%d,%s,%d%n",
                    trial, workers, estimate.getTasks(), estimate.getEstimatedSeconds(), estimate.getExpectedEvents(), estimate.getExpectedRows(),
                    wall, cpuSeconds, (last.get() - begin) / 1e9, Probe.seconds("ExperimentExecutor.execute"),
                    Probe.seconds("ReliabilityModel.runReplication"), Probe.seconds("SeriesWriter.writeWindow"),
                    Probe.seconds("SeriesWriter.finish"), Probe.seconds("ArtifactWriter.writeReplication"),
                    Probe.seconds("ArtifactWriter.summarize"), Probe.seconds("ArtifactWriter.write"), Probe.events.sum(), gcMs, result.getRunDirectory(), epoch);
                System.out.flush();
            }
        }
    }
}
```
