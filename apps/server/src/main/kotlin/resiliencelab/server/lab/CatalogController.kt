package resiliencelab.server.lab

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.catalog.Catalog
import resiliencelab.core.catalog.Stage1Catalog

/** Computable block and connection types (ADR 0001). */
@RestController
class CatalogController {
    @GetMapping("/api/v1/catalog")
    fun getCatalog(): Catalog = Stage1Catalog.catalog
}
