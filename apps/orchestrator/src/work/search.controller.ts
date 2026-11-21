import { Controller, Get, Inject, Query } from '@nestjs/common';
import { SearchQuerySchema, type Principal, type SearchQuery } from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchService } from './search.service.js';

/** REST `GET /search`: grouped hits across the user's whole record. */
@Controller('search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly searchService: SearchService) {}

  @Get()
  search(
    @Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.searchService.search(principal.userId, query);
  }
}
