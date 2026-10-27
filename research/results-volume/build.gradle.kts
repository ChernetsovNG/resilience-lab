plugins {
    application
}

repositories {
    mavenCentral()
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
}

dependencies {
    implementation("org.apache.arrow:arrow-vector:19.0.0")
    implementation("org.apache.arrow:arrow-memory-netty:19.0.0")
    implementation("org.apache.parquet:parquet-hadoop:1.18.1")
    implementation("org.apache.hadoop:hadoop-common:3.4.3")
    runtimeOnly("org.slf4j:slf4j-nop:2.0.17")
}

configurations.configureEach {
    exclude(group = "org.slf4j", module = "slf4j-reload4j")
}

application {
    mainClass.set("resiliencelab.research.ResultsVolume")
    applicationDefaultJvmArgs = listOf(
        "--add-opens=java.base/java.nio=ALL-UNNAMED",
        "--sun-misc-unsafe-memory-access=allow",
        "--enable-native-access=ALL-UNNAMED",
        "-Xms64m",
        "-Xmx1g",
    )
}
