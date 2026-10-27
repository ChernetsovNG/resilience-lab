FROM eclipse-temurin:25-jdk AS build
WORKDIR /app
COPY . .
RUN ./gradlew --no-daemon :apps:server:bootJar

FROM eclipse-temurin:25-jre
RUN groupadd --system app && useradd --system --gid app app && mkdir /app && chown app:app /app
WORKDIR /app
COPY --from=build /app/apps/server/build/libs/server.jar /app/server.jar
COPY --from=build --chown=app:app /app/examples /workspace
ENV RESILIENCE_LAB_WORKSPACE=/workspace
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/server.jar"]
