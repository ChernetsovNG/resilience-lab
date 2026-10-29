FROM eclipse-temurin:25-jdk AS build
WORKDIR /app
# Layers go from rarely to often changed, so a source edit reuses the cached
# Gradle distribution and dependencies instead of downloading them again.
COPY gradlew settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle/ gradle/
RUN ./gradlew --no-daemon --version
COPY core/build.gradle.kts core/
COPY apps/cli/build.gradle.kts apps/cli/
COPY apps/server/build.gradle.kts apps/server/
# Writing verification metadata resolves every configuration and downloads its
# artifacts; `dependencies` would fetch only metadata. The file is removed so the
# build below does not turn on dependency verification.
RUN ./gradlew --no-daemon --quiet --write-verification-metadata sha256 help \
    && rm gradle/verification-metadata.xml
COPY . .
RUN ./gradlew --no-daemon :apps:server:bootJar

FROM eclipse-temurin:25-jre
RUN groupadd --system app && useradd --system --gid app app && mkdir /app && chown app:app /app
WORKDIR /tmp
COPY --from=build /app/apps/server/build/libs/server.jar /app/server.jar
COPY --from=build --chown=app:app /app/examples /workspace
ENV RESILIENCE_LAB_WORKSPACE=/workspace
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/server.jar"]
