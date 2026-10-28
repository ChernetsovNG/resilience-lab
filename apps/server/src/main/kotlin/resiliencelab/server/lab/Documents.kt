package resiliencelab.server.lab

import resiliencelab.core.document.DecodeResult
import resiliencelab.core.document.DocumentCodec

/** Converts between [DocumentContent] and the stored canonical text of each document kind. */
internal object Documents {
    fun decode(
        kind: DocumentKind,
        text: String,
        path: String,
    ): DecodeResult<DocumentContent> =
        when (kind) {
            DocumentKind.MODEL -> DocumentCodec.decodeModel(text, path).toContent { DocumentContent(model = it) }
            DocumentKind.LAYOUT -> DocumentCodec.decodeLayout(text, path).toContent { DocumentContent(layout = it) }
            DocumentKind.EXPERIMENT -> DocumentCodec.decodeExperiment(text, path).toContent { DocumentContent(experiment = it) }
        }

    /** Canonical text, or null when [content] does not hold exactly the property of [kind]. */
    fun encode(
        kind: DocumentKind,
        content: DocumentContent,
    ): String? {
        if (listOfNotNull(content.model, content.layout, content.experiment).size != 1) return null
        return when (kind) {
            DocumentKind.MODEL -> content.model?.let(DocumentCodec::encodeModel)
            DocumentKind.LAYOUT -> content.layout?.let(DocumentCodec::encodeLayout)
            DocumentKind.EXPERIMENT -> content.experiment?.let(DocumentCodec::encodeExperiment)
        }
    }

    /** Converts unique API drafts to canonical document text without saving them. */
    fun draftTexts(drafts: List<DocumentDraft>): Map<String, String> {
        val texts =
            drafts.associate { draft ->
                val kind =
                    DocumentKind.of(draft.path)
                        ?: throw BadRequest("DOCUMENT_KIND", "'${draft.path}' is not a model, layout or experiment document")
                val text =
                    encode(kind, draft.content)
                        ?: throw BadRequest("DOCUMENT_KIND", "Content must hold exactly one document of the kind of '${draft.path}'")
                draft.path to text
            }
        if (texts.size != drafts.size) throw BadRequest("DRAFT_PATH", "Draft document paths must be unique")
        return texts
    }

    private inline fun <T> DecodeResult<T>.toContent(wrap: (T) -> DocumentContent): DecodeResult<DocumentContent> =
        when (this) {
            is DecodeResult.Ok -> DecodeResult.Ok(wrap(value))
            is DecodeResult.Failed -> this
        }
}
