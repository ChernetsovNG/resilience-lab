pluginManagement {
    repositories { gradlePluginPortal(); mavenCentral() }
}
dependencyResolutionManagement { repositories { mavenCentral() } }
rootProject.name = "latency-sketch"
// One-way dependency: the application's build does not include this research project.
includeBuild("../..") {
    dependencySubstitution {
        substitute(module("resiliencelab:core")).using(project(":core"))
    }
}
